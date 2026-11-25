import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { closeSheet, getSheetState } from "@/features/sheets/sheet-store";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
}));

test.each([
  ["/inbox", "Inbox", "Nothing in your inbox."],
  ["/tasks", "Tasks", "No open tasks."],
  ["/schedules", "Schedules", "No schedules yet."],
])("%s shows its heading and empty line", async (path, title, text) => {
  mockApi({
    "GET /api/setup": () => json({ hasCredential: true, hasTemplate: true, hasAgent: true }),
    "GET /api/inbox?": () => json({ chats: [], items: [], nextCursor: null }),
    "GET /api/tasks?": () => json({ tasks: [], nextCursor: null }),
    "GET /api/schedules": () => json({ schedules: [], more: false }),
    "GET /api/agents?": () => json({ agents: [], more: false, running: { count: 0, max: 8 } }),
  });
  renderApp(path, alice);
  expect(await screen.findByRole("heading", { level: 1, name: title })).toBeInTheDocument();
  expect(await screen.findByText(text)).toBeInTheDocument();
});

test("/agents with no agents: No agents yet. and a primary Create your first agent, even with nothing set up", async () => {
  mockApi({
    "GET /api/agents?": () => json({ agents: [], more: false, running: { count: 0, max: 8 } }),
    "GET /api/credentials": () => json({ credentials: [] }),
    "GET /api/templates": () => json({ dir: "/d", templates: [] }),
  });
  renderApp("/agents", alice);
  const main = await screen.findByRole("main");
  expect(await within(main).findByText("No agents yet.")).toBeInTheDocument();
  const create = within(main).getByRole("button", { name: "Create your first agent" });
  expect(create).toHaveAttribute("data-variant", "default");
  await userEvent.click(create);
  expect(getSheetState().parent).toMatchObject({ kind: "new-agent" });
  act(() => closeSheet());
});
