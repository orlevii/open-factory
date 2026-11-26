import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { notify } from "@/components/ui/toaster";
import { clearDraft } from "@/features/sheets/drafts";
import { closeSheet, openSheet } from "@/features/sheets/sheet-store";
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
const renderNewTask = async () => {
  const app = renderApp("/tasks", alice);
  await screen.findByRole("heading", { level: 1, name: "Tasks" });
  act(() => openSheet({ kind: "new-task" }));
  return app;
};
/** The sheet's Assignee picker; the Tasks list behind it has a filter by the same name. */
const assigneeField = async () =>
  within(await screen.findByRole("dialog", { name: "New task" })).findByLabelText("Assignee");
/** The sheet's reserved outcome line (the footer's `role=alert`). */
const outcomeAlert = () =>
  within(screen.getByRole("dialog", { name: "New task" }))
    .getAllByRole("alert")
    .find((el) => el.closest(".form-outcome")) as HTMLElement;
const moreToggle = () => screen.getByRole("button", { name: "More options" });
const openMore = async () =>
  userEvent.click(await screen.findByRole("button", { name: "More options" }));

const agents = () =>
  json({
    agents: [agentSummary({ slug: "dev", displayName: "Dev" })],
    more: false,
    running: { count: 0 },
  });
const summary = (n: number, status = "open") => ({
  key: `T-${n}`,
  title: `Task ${n}`,
  status,
  assignee: null,
  blockedBy: [],
  createdBy: { kind: "human", ref: "ref-or", handle: "or" },
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
  await renderNewTask();
  const title = await screen.findByLabelText("Title");
  // Leaving a field never edited says nothing.
  await userEvent.click(title);
  await userEvent.tab();
  expect(document.getElementById("field-title-error")).not.toHaveAttribute("data-shown");
  await userEvent.type(title, "x");
  await userEvent.clear(title);
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
  expect(await screen.findByText("Use 200 characters or fewer.")).toBeInTheDocument();
  expect(titleError()).toHaveAttribute("data-shown");
});

test("submit checks everything again and focuses the first invalid field", async () => {
  const api = mockApi(base);
  await renderNewTask();
  await userEvent.click(await screen.findByRole("button", { name: "Create task" }));
  expect(await screen.findByText("Enter a title.")).toBeInTheDocument();
  expect(screen.getByLabelText("Title")).toHaveFocus();
  expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(0);
});

test("dependency keys resolve in one request on leave and show as a summary; errors use the exact sentences", async () => {
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
  await renderNewTask();
  await openMore();
  const deps = await screen.findByLabelText("Depends on");
  await userEvent.type(deps, "T-41, T-44");
  await userEvent.tab();
  expect(await screen.findByText("Depends on T-41 and T-44.")).toBeInTheDocument();
  expect(api.calls.filter((c) => c.url.includes("keys="))).toHaveLength(1);
  await userEvent.clear(deps);
  await userEvent.type(deps, "banana");
  // Tab lands on Add link, a data-skip-validate control: not a leave that says an error (§5.4).
  await userEvent.tab();
  expect(screen.getByRole("button", { name: "Add link" })).toHaveFocus();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(deps).not.toHaveAttribute("aria-invalid");
  // Leaving for another field is.
  await userEvent.click(deps);
  await userEvent.click(screen.getByLabelText("Title"));
  expect(await screen.findByText("Use task keys, like T-41.")).toBeInTheDocument();
  await userEvent.clear(deps);
  await userEvent.type(deps, "T-99");
  await userEvent.click(screen.getByLabelText("Title"));
  expect(await screen.findByText("No such task.")).toBeInTheDocument();
});

test("links: add and remove rows; a javascript: target is refused on leave", async () => {
  mockApi(base);
  await renderNewTask();
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
  await renderNewTask();
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
  await renderNewTask();
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
  await waitFor(() =>
    expect(outcomeAlert()).toHaveTextContent("Couldn't create the task. Try again."),
  );
});

test("Close dismisses the sheet without a dialog and keeps the draft", async () => {
  const confirm = vi.spyOn(window, "confirm");
  mockApi(base);
  const { router } = await renderNewTask();
  await userEvent.type(await screen.findByLabelText("Title"), "Keep me");
  await userEvent.click(screen.getAllByRole("button", { name: "Close" }).at(-1) as HTMLElement);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull());
  expect(router.state.location.pathname).toBe("/tasks");
  expect(confirm).not.toHaveBeenCalled();
  confirm.mockRestore();
  act(() => openSheet({ kind: "new-task" }));
  expect(await screen.findByText(/Draft restored/)).toBeInTheDocument();
  expect(screen.getByLabelText("Title")).toHaveValue("Keep me");
});

test("fields run Title, Assignee, Description; More options is closed", async () => {
  mockApi(base);
  await renderNewTask();
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
  await renderNewTask();
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
        running: { count: 0 },
      }),
  });
  await renderNewTask();
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

const badRequest = (fields: Record<string, string>) =>
  json({ error: { code: "validation_error", message: "x", fields } }, 400);

test("bad keys on submit with More options folded by the user: it opens and Depends on takes focus", async () => {
  const api = mockApi(base);
  await renderNewTask();
  await userEvent.type(await screen.findByLabelText("Title"), "Plan");
  await openMore();
  await userEvent.type(screen.getByLabelText("Depends on"), "banana");
  await userEvent.click(moreToggle());
  expect(moreToggle()).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(screen.getByRole("button", { name: "Create task" }));
  await waitFor(() => expect(screen.getByLabelText("Depends on")).toHaveFocus());
  expect(moreToggle()).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("Use task keys, like T-41.")).toBeInTheDocument();
  expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(0);
});

test("a bad link on a second submit reopens More options the user folded again", async () => {
  mockApi(base);
  await renderNewTask();
  await userEvent.type(await screen.findByLabelText("Title"), "Plan");
  await openMore();
  await userEvent.click(screen.getByRole("button", { name: "Add link" }));
  await userEvent.type(screen.getByLabelText("Link 1 target"), "javascript:x");
  await userEvent.click(screen.getByRole("button", { name: "Create task" }));
  await waitFor(() => expect(screen.getByLabelText("Link 1 target")).toHaveFocus());
  await userEvent.click(moreToggle());
  expect(moreToggle()).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(screen.getByRole("button", { name: "Create task" }));
  await waitFor(() => expect(screen.getByLabelText("Link 1 target")).toHaveFocus());
  expect(moreToggle()).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("Links must be http(s) URLs.")).toBeInTheDocument();
});

test("a server links error with no rows is the outcome line; with rows, the first row's note", async () => {
  const api = mockApi({
    ...base,
    "POST /api/tasks": () => badRequest({ links: "Too many links." }),
  });
  await renderNewTask();
  await userEvent.type(await screen.findByLabelText("Title"), "Plan");
  await userEvent.click(screen.getByRole("button", { name: "Create task" }));
  await waitFor(() => expect(outcomeAlert()).toHaveTextContent("Too many links."));
  await openMore();
  await userEvent.click(screen.getByRole("button", { name: "Add link" }));
  await userEvent.type(screen.getByLabelText("Link 1 target"), "https://a.example");
  await userEvent.click(screen.getByRole("button", { name: "Create task" }));
  await waitFor(() => expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(2));
  const target = screen.getByLabelText("Link 1 target");
  await waitFor(() => expect(target).toHaveAttribute("aria-invalid", "true"));
  const note = document.getElementById(target.getAttribute("aria-describedby") ?? "");
  expect(note).toHaveTextContent("Too many links.");
  expect(note).toHaveAttribute("data-shown");
  await waitFor(() => expect(target).toHaveFocus());
  expect(outcomeAlert()).toHaveTextContent("");
});

test("a row added while links are flagged shows nothing until it is blurred", async () => {
  mockApi(base);
  await renderNewTask();
  await openMore();
  await userEvent.click(screen.getByRole("button", { name: "Add link" }));
  await userEvent.type(screen.getByLabelText("Link 1 target"), "javascript:x");
  await userEvent.tab();
  expect(await screen.findByText("Links must be http(s) URLs.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Add link" }));
  const second = screen.getByLabelText("Link 2 target");
  await userEvent.type(second, "ftp://x");
  expect(second).not.toHaveAttribute("aria-invalid");
  await userEvent.tab();
  await waitFor(() => expect(second).toHaveAttribute("aria-invalid", "true"));
});

test("a bad link in a row never blurred blocks the submit and takes focus", async () => {
  const api = mockApi(base);
  await renderNewTask();
  await userEvent.type(await screen.findByLabelText("Title"), "Plan");
  await openMore();
  await userEvent.click(screen.getByRole("button", { name: "Add link" }));
  // Enter submits from inside the row: the target is never blurred.
  await userEvent.type(screen.getByLabelText("Link 1 target"), "javascript:x{Enter}");
  await waitFor(() => expect(screen.getByLabelText("Link 1 target")).toHaveFocus());
  expect(screen.getByLabelText("Link 1 target")).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByText("Links must be http(s) URLs.")).toBeInTheDocument();
  expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(0);
});

test("after Discard the hidden error layer still holds the old text and nothing is shown (D2); More options folds", async () => {
  mockApi(base);
  await renderNewTask();
  await userEvent.type(await screen.findByLabelText("Description"), "Notes");
  act(() => closeSheet());
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull());
  act(() => openSheet({ kind: "new-task" }));
  await screen.findByText(/Draft restored/);
  await openMore();
  expect(moreToggle()).toHaveAttribute("aria-expanded", "true");
  const title = screen.getByLabelText("Title");
  await userEvent.type(title, "x");
  await userEvent.clear(title);
  await userEvent.tab();
  const error = () => document.getElementById("field-title-error");
  await waitFor(() => expect(error()).toHaveAttribute("data-shown"));
  await userEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(screen.getByLabelText("Description")).toHaveValue("");
  expect(error()).not.toHaveAttribute("data-shown");
  expect(error()).toHaveTextContent("Enter a title.");
  expect(screen.getByLabelText("Title")).not.toHaveAttribute("aria-invalid");
  expect(moreToggle()).toHaveAttribute("aria-expanded", "false");
});

test("clicking More options after clearing Title doesn't validate Title", async () => {
  mockApi(base);
  await renderNewTask();
  const title = await screen.findByLabelText("Title");
  await userEvent.type(title, "x");
  await userEvent.clear(title);
  await openMore();
  expect(screen.getByLabelText("Depends on")).toBeInTheDocument();
  expect(document.getElementById("field-title-error")).not.toHaveAttribute("data-shown");
});

test("a dependency lookup that returns after the keys changed is dropped", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const api = mockApi({
    ...base,
    "GET /api/tasks?": async (_b, url) => {
      if (url.includes("T-99")) await gate;
      return json({ tasks: url.includes("keys=") ? [summary(41)] : [], nextCursor: null });
    },
  });
  await renderNewTask();
  await openMore();
  const deps = screen.getByLabelText("Depends on");
  await userEvent.type(deps, "T-99");
  await userEvent.tab();
  await waitFor(() => expect(api.calls.some((c) => c.url.includes("T-99"))).toBe(true));
  await userEvent.clear(deps);
  await userEvent.type(deps, "T-41");
  release();
  await act(async () => {
    await gate;
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(deps).not.toHaveAttribute("aria-invalid");
  expect(document.getElementById("field-dependsOn-error")).not.toHaveAttribute("data-shown");
  expect(screen.queryByText("No such task.")).toBeNull();
});

test("a server dependency error survives tabbing out of the unchanged field", async () => {
  const cycle = "T-2 already depends on T-1; that would make a cycle.";
  const api = mockApi({
    ...base,
    "GET /api/tasks?": (_b, url) =>
      json({ tasks: url.includes("keys=") ? [summary(41)] : [], nextCursor: null }),
    "POST /api/tasks": () => badRequest({ dependsOn: cycle }),
  });
  await renderNewTask();
  await userEvent.type(await screen.findByLabelText("Title"), "Plan");
  await openMore();
  await userEvent.type(screen.getByLabelText("Depends on"), "T-41");
  await userEvent.click(screen.getByRole("button", { name: "Create task" }));
  expect(await screen.findByText(cycle)).toBeInTheDocument();
  await waitFor(() => expect(screen.getByLabelText("Depends on")).toHaveFocus());
  const lookups = () => api.calls.filter((c) => c.url.includes("keys=")).length;
  const before = lookups();
  await userEvent.tab();
  await waitFor(() => expect(lookups()).toBe(before + 1));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(document.getElementById("field-dependsOn-error")).toHaveAttribute("data-shown");
  expect(document.getElementById("field-dependsOn-error")).toHaveTextContent(cycle);
});

test("a valid first link and a bad second: submit focuses the second and the first shows nothing", async () => {
  const api = mockApi(base);
  await renderNewTask();
  await userEvent.type(await screen.findByLabelText("Title"), "Plan");
  await openMore();
  await userEvent.click(screen.getByRole("button", { name: "Add link" }));
  await userEvent.type(screen.getByLabelText("Link 1 target"), "https://a.example");
  await userEvent.click(screen.getByRole("button", { name: "Add link" }));
  await userEvent.type(screen.getByLabelText("Link 2 target"), "javascript:x");
  await userEvent.click(screen.getByRole("button", { name: "Create task" }));
  await waitFor(() => expect(screen.getByLabelText("Link 2 target")).toHaveFocus());
  expect(screen.getByLabelText("Link 2 target")).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByLabelText("Link 1 target")).not.toHaveAttribute("aria-invalid");
  expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(0);
});

test("an over-long description marks the editor, returns to Write and focuses the textarea", async () => {
  const api = mockApi(base);
  await renderNewTask();
  await userEvent.type(await screen.findByLabelText("Title"), "Plan");
  fireEvent.change(screen.getByLabelText("Description"), {
    target: { value: "a".repeat(64 * 1024 + 1) },
  });
  await userEvent.click(screen.getByRole("tab", { name: "Preview" }));
  expect(screen.queryByLabelText("Description")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Create task" }));
  await waitFor(() => expect(screen.getByLabelText("Description")).toHaveFocus());
  expect(screen.getByRole("tab", { name: "Write" })).toHaveAttribute("aria-selected", "true");
  expect(document.querySelector("[data-invalid]")).toContainElement(
    screen.getByLabelText("Description"),
  );
  expect(screen.getByText("Shorten this to 64 KB or less.")).toBeInTheDocument();
  expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(0);
});

test("a failed dependency lookup on submit is the outcome line", async () => {
  const api = mockApi({
    ...base,
    "GET /api/tasks?": (_b, url) =>
      url.includes("keys=")
        ? json({ error: { code: "internal_error", message: "boom" } }, 500)
        : json({ tasks: [], nextCursor: null }),
  });
  await renderNewTask();
  await userEvent.type(await screen.findByLabelText("Title"), "Plan");
  await openMore();
  await userEvent.type(screen.getByLabelText("Depends on"), "T-41");
  await userEvent.click(screen.getByRole("button", { name: "Create task" }));
  await waitFor(() =>
    expect(outcomeAlert()).toHaveTextContent("Couldn't create the task. Try again."),
  );
  expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(0);
});

test("a stale assignee blocks the submit until another is picked; Unassigned goes through", async () => {
  const api = mockApi({
    ...base,
    "GET /api/agents?": (_b, url) =>
      url.includes("ended=only")
        ? json({
            agents: [agentSummary({ slug: "ada", displayName: "Ada" })],
            more: false,
            running: { count: 0 },
          })
        : agents(),
    "POST /api/tasks": () => json({ task: detail(42) }, 201),
  });
  renderApp("/tasks", alice);
  act(() => openSheet({ kind: "new-task", assignee: "ada" }));
  expect(await screen.findByText("That agent has ended; pick another.")).toBeInTheDocument();
  expect(await assigneeField()).toHaveAttribute("aria-invalid", "true");
  await userEvent.type(screen.getByLabelText("Title"), "Plan");
  await userEvent.click(screen.getByRole("button", { name: "Create task" }));
  const field = await assigneeField();
  await waitFor(() => expect(field).toHaveFocus());
  expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  await pickComboOption(field, /Unassigned/);
  expect(document.getElementById("field-assignee-error")).not.toHaveAttribute("data-shown");
  await userEvent.click(screen.getByRole("button", { name: "Create task" }));
  await waitFor(() => expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(1));
  expect(api.calls.find((c) => c.method === "POST")?.body).toEqual({
    title: "Plan",
    body: "",
    dependsOn: [],
    links: [],
  });
});

test("moving from an edited, invalid Description to More options by keyboard doesn't validate it", async () => {
  mockApi(base);
  await renderNewTask();
  const body = await screen.findByLabelText("Description");
  act(() => body.focus());
  fireEvent.change(body, { target: { value: "x".repeat(70_000) } });
  // A keyboard move: the blur's relatedTarget is More options, with no pointerdown to fall back on.
  act(() => moreToggle().focus());
  expect(body).not.toHaveAttribute("aria-invalid");
  act(() => body.focus());
  act(() => screen.getByRole("button", { name: "Create task" }).focus());
  expect(body).toHaveAttribute("aria-invalid", "true");
});
