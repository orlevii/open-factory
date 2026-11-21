import { screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
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
    "GET /api/inbox?": () => json({ items: [], nextCursor: null }),
    "GET /api/tasks?": () => json({ tasks: [], nextCursor: null }),
    "GET /api/schedules": () => json({ schedules: [], more: false }),
    "GET /api/agents?": () => json({ agents: [], more: false, running: { count: 0, max: 8 } }),
  });
  renderApp(path, alice);
  expect(await screen.findByRole("heading", { level: 1, name: title })).toBeInTheDocument();
  expect(await screen.findByText(text)).toBeInTheDocument();
});

test("the dashboard shows the Inbox and Agents panels, each empty", async () => {
  mockApi({
    "GET /api/inbox?": () => json({ items: [], nextCursor: null }),
    "GET /api/inbox/unread-count": () => json({ count: 0 }),
    "GET /api/agents?": () => json({ agents: [], more: false, running: { count: 0, max: 8 } }),
  });
  renderApp("/", alice);
  expect(await screen.findByText("Nothing unread.")).toBeInTheDocument();
  const main = screen.getByRole("main");
  expect(await within(main).findByText("No agents yet.")).toBeInTheDocument();
});

test("the sidebar links every section in order", async () => {
  renderApp("/", alice);
  const nav = await screen.findByRole("navigation", { name: "Main" });
  const labels = within(nav)
    .getAllByRole("link")
    .map((a) => a.textContent);
  expect(labels).toEqual(["Inbox", "Tasks", "Templates", "Schedules", "Usage", "Settings"]);
  // The Agents row follows the nav and heads the tree.
  expect(screen.getByRole("link", { name: "Agents" })).toHaveAttribute("href", "/agents");
});
