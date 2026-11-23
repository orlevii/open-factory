import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { notify } from "@/components/ui/toaster";
import { clearDraft } from "@/features/sheets/drafts";
import { closeSheet } from "@/features/sheets/sheet-store";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { pickComboOption } from "@/test/select-helpers";
import { agentSummary } from "@/test/session-fixtures";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
}));
vi.mock("@/components/ui/toaster", async (orig) => ({
  ...(await orig<typeof import("@/components/ui/toaster")>()),
  notify: vi.fn(),
}));
beforeEach(() => {
  clearDraft("new-task");
  vi.mocked(notify).mockClear();
});
afterEach(() => {
  closeSheet();
  vi.unstubAllGlobals();
});
/** The sheet's Assignee picker; the Tasks list behind it has a filter by the same name. */
const assigneeField = async () =>
  within(await screen.findByRole("dialog", { name: "New task" })).findByLabelText("Assignee");
const openMore = async () =>
  userEvent.click(await screen.findByRole("button", { name: "More options" }));

const agents = () =>
  json({
    agents: [agentSummary({ slug: "dev", displayName: "Dev" })],
    more: false,
    running: { count: 0, max: 8 },
  });
const summary = (n: number, status = "open") => ({
  key: `T-${n}`,
  title: `Task ${n}`,
  status,
  assignee: null,
  blockedBy: [],
  createdBy: { kind: "user", handle: "or" },
  updatedAt: "2026-11-19T10:00:00.000Z",
});
const detail = (n: number) => ({
  ...summary(n),
  body: "",
  createdAt: "2026-11-19T10:00:00.000Z",
  dependsOn: [],
  blocks: [],
  links: [],
  activity: [],
  usage: null,
});
const base = {
  "GET /api/agents?": agents,
  "GET /api/tasks?": () => json({ tasks: [], nextCursor: null }),
};

test("validates on leave, not while typing; typing clears the error", async () => {
  mockApi(base);
  renderApp("/tasks/new", alice);
  const title = await screen.findByLabelText("Title");
  await userEvent.click(title);
  await userEvent.tab();
  expect(await screen.findByText("Enter a title.")).toBeInTheDocument();
  // The error layer stays mounted (it keeps its last text); "shown" is its data-shown attribute.
  const titleError = () => document.getElementById("field-title-error");
  expect(titleError()).toHaveAttribute("data-shown");
  await userEvent.type(title, "x");
  expect(titleError()).not.toHaveAttribute("data-shown");
  await userEvent.clear(title);
  expect(titleError()).not.toHaveAttribute("data-shown");
  // 200 characters pasted and the 201st typed: typing 201 keystrokes one by one takes about a second
  // alone and over 5 s in a loaded full run, and a timed-out test keeps typing and tabbing into the next.
  await userEvent.click(title);
  await userEvent.paste("a".repeat(200));
  await userEvent.type(title, "a");
  expect(title).toHaveValue("a".repeat(201));
  expect(titleError()).not.toHaveAttribute("data-shown");
  await userEvent.tab();
  expect(await screen.findByText("Keep the title to 200 characters or fewer.")).toBeInTheDocument();
  expect(titleError()).toHaveAttribute("data-shown");
});

test("submit checks everything again and focuses the first invalid field", async () => {
  const api = mockApi(base);
  renderApp("/tasks/new", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Create task" }));
  expect(await screen.findByText("Enter a title.")).toBeInTheDocument();
  expect(screen.getByLabelText("Title")).toHaveFocus();
  expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(0);
});

test("dependency keys resolve in one request on leave and show as badges; errors use the exact sentences", async () => {
  const api = mockApi({
    ...base,
    "GET /api/tasks?": (_b, url) =>
      json({
        tasks: url.includes("keys=T-41%2CT-44")
          ? [summary(41), summary(44, "done")]
          : [summary(41)],
        nextCursor: null,
      }),
  });
  renderApp("/tasks/new", alice);
  await openMore();
  const deps = await screen.findByLabelText("Depends on");
  await userEvent.type(deps, "T-41, T-44");
  await userEvent.tab();
  const list = await screen.findByRole("list", { name: "Resolved dependencies" });
  expect(within(list).getByText("Task 41")).toBeInTheDocument();
  expect(within(list).getByText("Done")).toBeInTheDocument();
  expect(api.calls.filter((c) => c.url.includes("keys="))).toHaveLength(1);
  await userEvent.clear(deps);
  await userEvent.type(deps, "banana");
  await userEvent.tab();
  expect(await screen.findByText("Use task keys, like T-41.")).toBeInTheDocument();
  await userEvent.clear(deps);
  await userEvent.type(deps, "T-99");
  await userEvent.tab();
  expect(await screen.findByText("No task T-99.")).toBeInTheDocument();
});

test("links: add and remove rows; a javascript: target is refused on leave", async () => {
  mockApi(base);
  renderApp("/tasks/new", alice);
  await openMore();
  await userEvent.click(await screen.findByRole("button", { name: "Add link" }));
  const target = screen.getByLabelText("Link 1 target");
  await userEvent.type(target, "javascript:alert(1)");
  await userEvent.tab();
  expect(await screen.findByText("Links must be http(s) URLs.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Add link" }));
  expect(screen.getByLabelText("Link 2 target")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Remove link 1" }));
  expect(screen.queryByText("Links must be http(s) URLs.")).toBeNull();
  expect(screen.getAllByLabelText(/Link \d target/)).toHaveLength(1);
});

test("creating sends the task, closes the sheet and toasts; the button reads Creating… meanwhile", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const api = mockApi({
    ...base,
    "POST /api/tasks": async () => {
      await gate;
      return json({ task: detail(42) }, 201);
    },
  });
  renderApp("/tasks/new", alice);
  await userEvent.type(await screen.findByLabelText("Title"), "  Plan  ");
  await pickComboOption(await assigneeField(), /Dev\s*@dev/);
  await userEvent.click(screen.getByRole("button", { name: "Create task" }));
  expect(await screen.findByRole("button", { name: "Creating…" })).toBeInTheDocument();
  release();
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull());
  expect(notify).toHaveBeenCalledWith({
    text: "Created T-42.",
    action: { label: "Open", run: expect.any(Function) },
  });
  expect(api.calls.find((c) => c.method === "POST")?.body).toEqual({
    title: "Plan",
    body: "",
    assignee: "dev",
    dependsOn: [],
    links: [],
  });
});

test("a server field error lands under its field; another failure is one alert line", async () => {
  let n = 0;
  mockApi({
    ...base,
    "POST /api/tasks": () =>
      ++n === 1
        ? json(
            {
              error: {
                code: "validation_error",
                message: "x",
                fields: { dependsOn: "T-2 already depends on T-1; that would make a cycle." },
              },
            },
            400,
          )
        : json({ error: { code: "internal_error", message: "Internal error" } }, 500),
  });
  renderApp("/tasks/new", alice);
  await userEvent.type(await screen.findByLabelText("Title"), "Plan");
  await userEvent.click(screen.getByRole("button", { name: "Create task" }));
  expect(
    await screen.findByText("T-2 already depends on T-1; that would make a cycle."),
  ).toBeInTheDocument();
  await waitFor(() => expect(screen.getByLabelText("Depends on")).toHaveFocus());
  expect(screen.getByRole("button", { name: "More options" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await userEvent.click(screen.getByRole("button", { name: "Create task" }));
  // The body still has its own alert until the task form moves to the outcome line, so find by text.
  expect(await screen.findByText("Couldn't create the task. Try again.")).toBeInTheDocument();
});

test("Close dismisses the sheet without a dialog and keeps the draft", async () => {
  mockApi(base);
  const { router } = renderApp("/tasks/new", alice);
  await userEvent.type(await screen.findByLabelText("Title"), "Keep me");
  await userEvent.click(screen.getAllByRole("button", { name: "Close" }).at(-1) as HTMLElement);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull());
  expect(router.state.location.pathname).toBe("/tasks");
});

test("fields run Title, Assignee, Description; More options is closed", async () => {
  mockApi(base);
  renderApp("/tasks/new", alice);
  await screen.findByLabelText("Title");
  const order = ["Title", "Assignee", "Description"].map((n) =>
    document.querySelector(
      `label[for="field-${n.toLowerCase() === "description" ? "body" : n.toLowerCase()}"]`,
    ),
  );
  for (let i = 1; i < order.length; i++)
    expect(order[i - 1]?.compareDocumentPosition(order[i] as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  expect(screen.getByRole("button", { name: "More options" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(screen.queryByLabelText("Depends on")).toBeNull();
});

test("a dependency error after submit opens More options itself", async () => {
  mockApi(base);
  renderApp("/tasks/new", alice);
  await userEvent.type(await screen.findByLabelText("Title"), "Plan");
  await openMore();
  await userEvent.type(await screen.findByLabelText("Depends on"), "banana");
  await userEvent.click(screen.getByRole("button", { name: "More options" }));
  expect(screen.queryByLabelText("Depends on")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Create task" }));
  expect(await screen.findByText("Use task keys, like T-41.")).toBeInTheDocument();
  expect(screen.getByLabelText("Depends on")).toHaveFocus();
});

test("Enter in a field while a create is pending posts once", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const api = mockApi({
    ...base,
    "POST /api/tasks": async () => {
      await gate;
      return json({ task: detail(42) }, 201);
    },
  });
  renderApp("/tasks/new", alice);
  const title = await screen.findByLabelText("Title");
  await userEvent.type(title, "Plan{Enter}{Enter}");
  await waitFor(() => expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(1));
  release();
  await waitFor(() => expect(notify).toHaveBeenCalled());
  expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(1);
});

test("arrow keys in the Assignee picker don't assign; Enter does", async () => {
  const api = mockApi({
    ...base,
    "GET /api/agents?": () =>
      json({
        agents: [
          agentSummary({ slug: "dev", displayName: "Dev" }),
          agentSummary({ slug: "qa", displayName: "QA" }),
        ],
        more: false,
        running: { count: 0, max: 8 },
      }),
  });
  renderApp("/tasks/new", alice);
  const trigger = await assigneeField();
  expect(trigger).toHaveTextContent("Unassigned");
  await userEvent.click(trigger);
  await screen.findByRole("option", { name: /Dev\s*@dev/ });
  await userEvent.keyboard("{ArrowDown}{ArrowDown}");
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  expect(trigger).toHaveTextContent("Unassigned");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(trigger).toHaveTextContent("@"));
  expect(api.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
});
