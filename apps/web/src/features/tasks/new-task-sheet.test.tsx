import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { notify } from "@/components/ui/toaster";
import { clearDraft } from "@/features/sheets/drafts";
import { closeSheet, getSheetState } from "@/features/sheets/sheet-store";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { agentSummary } from "@/test/session-fixtures";
import { newTask } from "./actions";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
}));
vi.mock("@/components/ui/toaster", async (orig) => ({
  ...(await orig<typeof import("@/components/ui/toaster")>()),
  notify: vi.fn(),
}));

const agents =
  (...slugs: string[]) =>
  () =>
    json({
      agents: slugs.map((s) =>
        agentSummary({ slug: s, displayName: s[0]?.toUpperCase() + s.slice(1) }),
      ),
      more: false,
      running: { count: 0, max: 8 },
    });
const detail = (n: number) => ({
  key: `T-${n}`,
  title: "Plan",
  status: "open",
  assignee: null,
  blockedBy: [],
  createdBy: { kind: "user", handle: "or" },
  updatedAt: "2026-11-19T10:00:00.000Z",
  body: "",
  createdAt: "2026-11-19T10:00:00.000Z",
  dependsOn: [],
  blocks: [],
  links: [],
  activity: [],
  usage: null,
});
const base = {
  "GET /api/agents?": agents("ada", "bo"),
  "GET /api/tasks?": () => json({ tasks: [], nextCursor: null }),
};
const press = (key: string) => fireEvent.keyDown(document.body, { key });
const sheet = () => screen.findByRole("dialog", { name: "New task" });
const assignee = async () => within(await sheet()).findByLabelText("Assignee");

beforeEach(() => {
  localStorage.clear();
  fakeMatchMedia.install(false);
  clearDraft("new-task");
  vi.mocked(notify).mockClear();
});
afterEach(() => {
  act(() => closeSheet());
  vi.unstubAllGlobals();
});

test("c in a session prefills that agent, and the description says who it is for", async () => {
  mockApi(base);
  renderApp("/agents/ada", alice);
  await screen.findByRole("heading", { level: 1 });
  press("c");
  expect(await assignee()).toHaveTextContent("Ada");
  expect(within(await sheet()).getByText("For Ada")).toBeInTheDocument();
});

test("c on the Tasks list prefills its assignee filter", async () => {
  mockApi(base);
  renderApp("/tasks?assignee=bo", alice);
  await screen.findByRole("heading", { level: 1, name: "Tasks" });
  press("c");
  expect(await assignee()).toHaveTextContent("Bo");
});

test("anywhere else the task starts unassigned, with no description", async () => {
  mockApi(base);
  renderApp("/inbox", alice);
  await screen.findByRole("heading", { level: 1 });
  press("c");
  expect(await assignee()).toHaveTextContent("Unassigned");
  expect(within(await sheet()).queryByText(/^For /)).toBeNull();
});

test("newTask() reads the router at call time", async () => {
  mockApi(base);
  const { router } = renderApp("/agents/ada", alice);
  await screen.findByRole("heading", { level: 1 });
  newTask(router);
  expect(getSheetState().parent).toMatchObject({ kind: "new-task", assignee: "ada" });
});

test("a non-empty draft keeps its own assignee over the context prefill", async () => {
  mockApi(base);
  const { router } = renderApp("/inbox", alice);
  await screen.findByRole("heading", { level: 1 });
  press("c");
  await userEvent.type(within(await sheet()).getByLabelText("Title"), "Mine");
  await userEvent.click(await assignee());
  await userEvent.click(await screen.findByRole("option", { name: /Bo\s*@bo/ }));
  act(() => closeSheet());
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull());
  await act(() => router.navigate({ to: "/agents/$slug", params: { slug: "ada" } }));
  press("c");
  expect(await assignee()).toHaveTextContent("Bo");
  expect(screen.getByText(/Draft restored/)).toBeInTheDocument();
});

test("a draft whose assignee has ended clears it and says so", async () => {
  mockApi({ ...base, "GET /api/agents?": agents("ada") });
  renderApp("/inbox", alice);
  await screen.findByRole("heading", { level: 1 });
  press("c");
  await userEvent.type(within(await sheet()).getByLabelText("Title"), "Mine");
  await userEvent.click(await assignee());
  await userEvent.click(await screen.findByRole("option", { name: /Ada\s*@ada/ }));
  act(() => closeSheet());
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull());
  // Ada ends meanwhile: the lists no longer hold her.
  mockApi({ ...base, "GET /api/agents?": agents("bo") });
  const { queryClient } = renderApp("/inbox", alice);
  await screen.findAllByRole("heading", { level: 1 });
  await queryClient.invalidateQueries({ queryKey: ["agents"] });
  press("c");
  expect(await screen.findByText("@ada has ended; pick another.")).toBeInTheDocument();
  expect(await assignee()).toHaveTextContent("Unassigned");
});

test("a late success toasts Created · Open and does not navigate", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const { router } = (() => {
    mockApi({
      ...base,
      "POST /api/tasks": async () => {
        await gate;
        return json({ task: detail(42) }, 201);
      },
    });
    return renderApp("/inbox", alice);
  })();
  await screen.findByRole("heading", { level: 1 });
  press("c");
  await userEvent.type(within(await sheet()).getByLabelText("Title"), "Plan");
  await userEvent.click(screen.getByRole("button", { name: "Create task" }));
  await screen.findByRole("button", { name: "Creating…" });
  act(() => closeSheet());
  release();
  await waitFor(() =>
    expect(notify).toHaveBeenCalledWith({
      text: "Created T-42.",
      action: { label: "Open", run: expect.any(Function) },
    }),
  );
  expect(router.state.location.pathname).toBe("/inbox");
});

test("a late failure toasts the error with Open form, which reopens the kept draft", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  mockApi({
    ...base,
    "POST /api/tasks": async () => {
      await gate;
      return json({ error: { code: "internal_error", message: "Database is down" } }, 500);
    },
  });
  renderApp("/inbox", alice);
  await screen.findByRole("heading", { level: 1 });
  press("c");
  await userEvent.type(within(await sheet()).getByLabelText("Title"), "Plan");
  await userEvent.click(screen.getByRole("button", { name: "Create task" }));
  await screen.findByRole("button", { name: "Creating…" });
  act(() => closeSheet());
  release();
  await waitFor(() => expect(notify).toHaveBeenCalled());
  const n = vi.mocked(notify).mock.calls[0]?.[0];
  expect(n?.text).toBe("Database is down");
  expect(n?.action?.label).toBe("Open form");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull());
  act(() => n?.action?.run());
  expect(await within(await sheet()).findByLabelText("Title")).toHaveValue("Plan");
});
