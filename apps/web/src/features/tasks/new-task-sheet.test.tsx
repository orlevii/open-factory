import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { notify } from "@/components/ui/toaster";
import { clearDraft, hasDraft, resetDrafts } from "@/features/sheets/drafts";
import { closeSheet, getSheetState, openSheet } from "@/features/sheets/sheet-store";
import { installInputModality } from "@/lib/input-modality";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json, mockApi } from "@/test/mock-api";
import { refFor } from "@/test/refs";
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
        agentSummary({ handle: s, displayName: s[0]?.toUpperCase() + s.slice(1) }),
      ),
      more: false,
      running: { count: 0 },
    });
/** Live agents, and the ended list (`?ended=only`) apart. */
const liveEnded = (live: string[], ended: string[]) => (_b: unknown, url?: string) =>
  (url?.includes("ended=only") ? agents(...ended) : agents(...live))();
const detail = (n: number) => ({
  key: `T-${n}`,
  title: "Plan",
  status: "open",
  assignee: null,
  blockedBy: [],
  createdBy: { kind: "human", ref: refFor("or"), handle: "or" },
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
  renderApp(`/agents/${refFor("ada")}/session`, alice);
  await screen.findByRole("heading", { level: 1 });
  press("c");
  expect(await assignee()).toHaveTextContent("Ada");
  expect(within(await sheet()).getByText("For Ada")).toBeInTheDocument();
});

test("c on the Tasks list prefills its assignee filter", async () => {
  mockApi(base);
  renderApp(`/tasks?assignee=${refFor("bo")}`, alice);
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
  const { router } = renderApp(`/agents/${refFor("ada")}/session`, alice);
  await screen.findByRole("heading", { level: 1 });
  newTask(router);
  expect(getSheetState().parent).toMatchObject({ kind: "new-task", assignee: refFor("ada") });
});

test("a non-empty draft keeps its own assignee over the context prefill", async () => {
  mockApi(base);
  const { router } = renderApp("/inbox", alice);
  await screen.findByRole("heading", { level: 1 });
  press("c");
  await userEvent.type(await within(await sheet()).findByLabelText("Title"), "Mine");
  await userEvent.click(await assignee());
  await userEvent.click(await screen.findByRole("option", { name: /Bo\s*@bo/ }));
  act(() => closeSheet());
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull());
  await act(() => router.navigate({ to: "/agents/$ref/chat", params: { ref: refFor("ada") } }));
  press("c");
  expect(await assignee()).toHaveTextContent("Bo");
  expect(screen.getByText(/Draft restored/)).toBeInTheDocument();
});

test("a draft whose assignee has ended clears it and says so", async () => {
  mockApi({ ...base, "GET /api/agents?": agents("ada") });
  const first = renderApp("/inbox", alice);
  await screen.findByRole("heading", { level: 1 });
  press("c");
  await userEvent.type(await within(await sheet()).findByLabelText("Title"), "Mine");
  await userEvent.click(await assignee());
  await userEvent.click(await screen.findByRole("option", { name: /Ada\s*@ada/ }));
  act(() => closeSheet());
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull());
  // Ada ends meanwhile: the live list no longer holds her; the ended list does.
  first.unmount();
  mockApi({ ...base, "GET /api/agents?": liveEnded(["bo"], ["ada"]) });
  const { queryClient } = renderApp("/inbox", alice);
  await screen.findAllByRole("heading", { level: 1 });
  await queryClient.invalidateQueries({ queryKey: ["agents"] });
  press("c");
  expect(await screen.findByText("That agent has ended; pick another.")).toBeInTheDocument();
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
  await userEvent.type(await within(await sheet()).findByLabelText("Title"), "Plan");
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
  await userEvent.type(await within(await sheet()).findByLabelText("Title"), "Plan");
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

/** Submits "Plan" with POST held until `release()`, and closes the sheet while it is pending. */
async function submitThenClose() {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const api = mockApi({
    ...base,
    "POST /api/tasks": async () => {
      await gate;
      return json({ task: detail(42) }, 201);
    },
  });
  renderApp("/inbox", alice);
  await screen.findByRole("heading", { level: 1 });
  press("c");
  await userEvent.type(await within(await sheet()).findByLabelText("Title"), "Plan");
  await userEvent.click(screen.getByRole("button", { name: "Create task" }));
  await screen.findByRole("button", { name: "Creating…" });
  act(() => closeSheet());
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull());
  return { release, api };
}

test("a late success keeps a draft edited in a reopened New task, which stays open", async () => {
  const { release } = await submitThenClose();
  press("c");
  await userEvent.type(await within(await sheet()).findByLabelText("Title"), "Another");
  release();
  await waitFor(() => expect(notify).toHaveBeenCalled());
  expect(hasDraft("new-task")).toBe(true);
  expect(await within(await sheet()).findByLabelText("Title")).toHaveValue("PlanAnother");
});

test("a late success keeps edits made in a reopened New task that was closed again", async () => {
  const { release } = await submitThenClose();
  press("c");
  await userEvent.type(await within(await sheet()).findByLabelText("Title"), "Another");
  act(() => closeSheet());
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull());
  release();
  await waitFor(() => expect(notify).toHaveBeenCalled());
  expect(hasDraft("new-task")).toBe(true);
  press("c");
  expect(await within(await sheet()).findByLabelText("Title")).toHaveValue("PlanAnother");
});

test("a late success over a reopened New task still holding the sent values clears the draft and closes it", async () => {
  const { release, api } = await submitThenClose();
  press("c");
  expect(await within(await sheet()).findByLabelText("Title")).toHaveValue("Plan");
  expect(await screen.findByText(/Draft restored/)).toBeInTheDocument();
  release();
  await waitFor(() =>
    expect(notify).toHaveBeenCalledWith({
      text: "Created T-42.",
      action: { label: "Open", run: expect.any(Function) },
    }),
  );
  expect(hasDraft("new-task")).toBe(false);
  // The form holding the created values closes (so the held toast shows) instead of inviting a second Create.
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull());
  expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  press("c");
  expect(await within(await sheet()).findByLabelText("Title")).toHaveValue("");
});

test("a result landing after a sign-out neither toasts nor touches the next user's draft", async () => {
  const { release } = await submitThenClose();
  act(() => resetDrafts());
  // The next user types the same values: the late success must not take them for the sent draft.
  press("c");
  await userEvent.type(await within(await sheet()).findByLabelText("Title"), "Plan");
  release();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  expect(notify).not.toHaveBeenCalled();
  expect(hasDraft("new-task")).toBe(true);
  expect(screen.getByRole("dialog", { name: "New task" })).toBeInTheDocument();
});

test("a stale prefill that gets cleared leaves no draft, so the next prefill still applies", async () => {
  mockApi({ ...base, "GET /api/agents?": liveEnded(["bo"], ["ada"]) });
  renderApp("/inbox", alice);
  await screen.findByRole("heading", { level: 1 });
  act(() => openSheet({ kind: "new-task", assignee: refFor("ada") }));
  expect(await screen.findByText("That agent has ended; pick another.")).toBeInTheDocument();
  expect(screen.queryByText("For Ada")).toBeNull();
  act(() => closeSheet());
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull());
  expect(hasDraft("new-task")).toBe(false);
  act(() => openSheet({ kind: "new-task", assignee: refFor("bo") }));
  expect(await assignee()).toHaveTextContent("Bo");
  expect(screen.queryByText(/Draft restored/)).toBeNull();
});

test("a prefill naming no agent at all says so", async () => {
  mockApi({ ...base, "GET /api/agents?": liveEnded(["bo"], []) });
  renderApp("/inbox", alice);
  await screen.findByRole("heading", { level: 1 });
  act(() => openSheet({ kind: "new-task", assignee: refFor("typo") }));
  expect(await screen.findByText("No such agent; pick another.")).toBeInTheDocument();
  expect(screen.queryByText(/For /)).toBeNull();
});

test("a restored draft hides For X: the prefill did not apply", async () => {
  mockApi(base);
  renderApp("/inbox", alice);
  await screen.findByRole("heading", { level: 1 });
  press("c");
  await userEvent.type(await within(await sheet()).findByLabelText("Title"), "Mine");
  act(() => closeSheet());
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull());
  act(() => openSheet({ kind: "new-task", assignee: refFor("ada") }));
  expect(await screen.findByText(/Draft restored/)).toBeInTheDocument();
  expect(screen.queryByText("For Ada")).toBeNull();
});

test("Discard over a prefilled open brings the prefill back, with For X", async () => {
  mockApi(base);
  renderApp("/inbox", alice);
  await screen.findByRole("heading", { level: 1 });
  press("c");
  await userEvent.type(await within(await sheet()).findByLabelText("Title"), "Mine");
  act(() => closeSheet());
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull());
  act(() => openSheet({ kind: "new-task", assignee: refFor("ada") }));
  expect(await screen.findByText(/Draft restored/)).toBeInTheDocument();
  expect(screen.queryByText("For Ada")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(await assignee()).toHaveTextContent("Ada");
  expect(await screen.findByText("For Ada")).toBeInTheDocument();
});

test("Discard over a stale prefill leaves no phantom draft", async () => {
  mockApi({ ...base, "GET /api/agents?": liveEnded(["bo"], ["ada"]) });
  renderApp("/inbox", alice);
  await screen.findByRole("heading", { level: 1 });
  press("c");
  await userEvent.type(await within(await sheet()).findByLabelText("Title"), "Mine");
  act(() => closeSheet());
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull());
  act(() => openSheet({ kind: "new-task", assignee: refFor("ada") }));
  expect(await screen.findByText(/Draft restored/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(await screen.findByText("That agent has ended; pick another.")).toBeInTheDocument();
  expect(hasDraft("new-task")).toBe(false);
  act(() => closeSheet());
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull());
  act(() => openSheet({ kind: "new-task", assignee: refFor("bo") }));
  expect(await assignee()).toHaveTextContent("Bo");
  expect(screen.queryByText(/Draft restored/)).toBeNull();
});

test("desktop: Title takes focus when the body mounts", async () => {
  mockApi(base);
  renderApp("/inbox", alice);
  await screen.findByRole("heading", { level: 1 });
  press("c");
  const title = await within(await sheet()).findByLabelText("Title");
  await waitFor(() => expect(title).toHaveFocus());
});

test("phones: the drawer content holds focus (the keyboard doesn't rise mid-slide)", async () => {
  fakeMatchMedia.install(true);
  mockApi(base);
  renderApp("/inbox", alice);
  await screen.findByRole("heading", { level: 1 });
  press("c");
  await within(await sheet()).findByLabelText("Title");
  await waitFor(() =>
    expect(document.activeElement).toBe(document.querySelector("[data-slot=drawer-content]")),
  );
});

test("phones: the footer stacks Create task first and Close last", async () => {
  fakeMatchMedia.install(true);
  mockApi(base);
  renderApp("/inbox", alice);
  await screen.findByRole("heading", { level: 1 });
  press("c");
  const footer = (await sheet()).querySelector("[data-slot=drawer-footer]") as HTMLElement;
  const names = within(footer)
    .getAllByRole("button")
    .map((b) => b.textContent);
  expect(names).toEqual(["Create task", "Close"]);
});

test("a submit from the keyboard closes the sheet and its scrim instantly", async () => {
  const off = installInputModality();
  mockApi({ ...base, "POST /api/tasks": () => json({ task: detail(7) }, 201) });
  renderApp("/inbox", alice);
  await screen.findByRole("heading", { level: 1 });
  // Opened by pointer, so the opening itself is not stamped.
  fireEvent.pointerDown(document.body);
  act(() => openSheet({ kind: "new-task" }));
  const title = await within(await sheet()).findByLabelText("Title");
  const content = document.querySelector("[data-slot=sheet-content]") as HTMLElement;
  const overlay = document.querySelector("[data-slot=sheet-overlay]") as HTMLElement;
  expect(content).not.toHaveAttribute("data-instant");
  await userEvent.type(title, "Plan{Enter}");
  await waitFor(() => expect(getSheetState().parent).toBeUndefined());
  expect(content).toHaveAttribute("data-instant");
  expect(overlay).toHaveAttribute("data-instant");
  off();
});
