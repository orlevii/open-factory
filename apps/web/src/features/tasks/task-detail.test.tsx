import type { ServerMessage } from "@open-factory/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { agentSummary } from "@/test/session-fixtures";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
const ws = vi.hoisted(() => ({ push: (_m: ServerMessage) => {} }));
vi.mock("@/lib/ws", () => ({
  connectWs: (o: { onMessage?: (m: ServerMessage) => void; onOpen?: () => void }) => {
    ws.push = (m) => o.onMessage?.(m);
    setTimeout(() => o.onOpen?.(), 0);
    return { close() {}, status: () => "open", send: () => true };
  },
}));
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 19, 15, 0));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const at = (h: number, m: number) => new Date(2026, 10, 19, h, m).toISOString();
type Over = Record<string, unknown>;
const detail = (o: Over = {}) => ({
  key: "T-42",
  title: "Plan the billing migration",
  status: "in_progress",
  assignee: { slug: "dev", displayName: "Dev" },
  blockedBy: [],
  createdBy: { kind: "user", handle: "or" },
  updatedAt: at(9, 15),
  body: "The **brief**.",
  createdAt: at(9, 10),
  dependsOn: [],
  blocks: [],
  links: [],
  activity: [
    {
      type: "event",
      id: "e1",
      actor: { kind: "user", handle: "or" },
      event: "created",
      at: at(9, 10),
    },
    {
      type: "event",
      id: "e2",
      actor: { kind: "user", handle: "or" },
      event: "assignee",
      from: null,
      to: "dev",
      at: at(9, 10),
    },
    {
      type: "comment",
      id: "c1",
      author: { kind: "agent", slug: "dev" },
      body: "@or can you confirm?",
      at: at(9, 14),
    },
    {
      type: "event",
      id: "e3",
      actor: { kind: "agent", slug: "dev" },
      event: "status",
      from: "open",
      to: "in_progress",
      at: at(9, 15),
    },
  ],
  usage: null,
  ...o,
});
const agents = () =>
  json({
    agents: [
      agentSummary({ slug: "dev", displayName: "Dev" }),
      agentSummary({ slug: "qa", displayName: "QA" }),
    ],
    more: false,
    running: { count: 0, max: 8 },
  });
const world = (get: () => unknown = () => detail()) =>
  mockApi({
    "GET /api/agents?": agents,
    "GET /api/tasks/T-42": () => json(get()),
    "GET /api/tasks?": () => json({ tasks: [], nextCursor: null }),
  });
const patches = (api: ReturnType<typeof mockApi>) => api.calls.filter((c) => c.method === "PATCH");

test("header: the Tasks back link, the key in mono, the document title; the activity reads from structured events", async () => {
  world();
  renderApp("/tasks/T-42", alice);
  const heading = await screen.findByRole("heading", { level: 1 });
  expect(within(heading).getByRole("link", { name: "Tasks" })).toHaveAttribute("href", "/tasks");
  expect(within(heading).getByText("T-42")).toHaveClass("font-mono");
  await waitFor(() =>
    expect(document.title).toBe("T-42 · Plan the billing migration · Open Factory"),
  );
  const log = screen.getByRole("list", { name: "Activity" });
  expect(within(log).getByText(/created this task/)).toBeInTheDocument();
  expect(within(log).getByText(/assigned/)).toHaveTextContent("@or assigned @dev");
  expect(within(log).getByText(/moved this to in progress/)).toBeInTheDocument();
  expect(within(log).getByRole("article", { name: "Comment from @dev" })).toBeInTheDocument();
});

test("Status is a menu: arrow keys move without sending; Enter commits once; the result is announced", async () => {
  const api = world();
  api.on("PATCH /api/tasks/T-42", () => json({ task: detail({ status: "done" }) }));
  renderApp("/tasks/T-42", alice);
  const trigger = await screen.findByRole("button", { name: "Status: In progress" });
  trigger.focus();
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("menuitemradio", { name: "Done" });
  await userEvent.keyboard("{ArrowDown}{ArrowDown}");
  expect(patches(api)).toHaveLength(0);
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(patches(api)).toHaveLength(1));
  expect(patches(api)[0]?.body).toEqual({ status: "done" });
  expect(await screen.findByText("Status set to done")).toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "Status: Done" })).toBeInTheDocument();
});

test("Assignee: Enter on an item assigns it and says so; a failed commit reverts with the server's sentence", async () => {
  const api = world();
  let fail = false;
  api.on("PATCH /api/tasks/T-42", (b) =>
    fail
      ? json(
          {
            error: {
              code: "assignee_ended",
              message: "@qa was terminated and can't be assigned tasks.",
            },
          },
          409,
        )
      : json({
          task: detail({
            assignee: { slug: (b as { assignee: string }).assignee, displayName: "QA" },
          }),
        }),
  );
  renderApp("/tasks/T-42", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Assignee: @dev" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "@qa · QA" }));
  expect(await screen.findByText("Assigned to @qa")).toBeInTheDocument();
  expect(patches(api)[0]?.body).toEqual({ assignee: "qa" });
  fail = true;
  await userEvent.click(screen.getByRole("button", { name: "Assignee: @qa" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "@dev · Dev" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "@qa was terminated and can't be assigned tasks.",
  );
  expect(screen.getByRole("button", { name: "Assignee: @qa" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Assignee: @qa" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Unassigned" }));
  await waitFor(() => expect(patches(api).at(-1)?.body).toEqual({ assignee: null }));
});

test("an ended assignee shows muted above a 'Choose an agent…' trigger", async () => {
  world(() => detail({ assignee: { slug: "dev", displayName: "Dev", ended: "terminated" } }));
  renderApp("/tasks/T-42", alice);
  expect(
    await screen.findByRole("button", { name: "Assignee: Choose an agent…" }),
  ).toBeInTheDocument();
  expect(
    screen.getByText((_, el) => el?.tagName === "P" && el.textContent === "@dev · terminated"),
  ).toBeInTheDocument();
});

test("title edit: focus goes into the input, Enter saves, Escape cancels, focus returns to Edit title", async () => {
  const api = world();
  api.on("PATCH /api/tasks/T-42", () => json({ task: detail({ title: "New title" }) }));
  renderApp("/tasks/T-42", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Edit title" }));
  const input = screen.getByLabelText("Title");
  expect(input).toHaveFocus();
  expect(screen.getByText("Saving sends the new title to @dev.")).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByLabelText("Title")).toBeNull();
  await waitFor(() => expect(screen.getByRole("button", { name: "Edit title" })).toHaveFocus());
  await userEvent.click(screen.getByRole("button", { name: "Edit title" }));
  await userEvent.clear(screen.getByLabelText("Title"));
  await userEvent.type(screen.getByLabelText("Title"), "New title{Enter}");
  await waitFor(() =>
    expect(screen.getByRole("heading", { level: 2, name: "New title" })).toBeInTheDocument(),
  );
  expect(patches(api)[0]?.body).toEqual({ title: "New title" });
  await waitFor(() => expect(screen.getByRole("button", { name: "Edit title" })).toHaveFocus());
});

test("title edit: focus returns to Edit title even when a frame fires before React renders it", async () => {
  // Under a loaded full run a frame can run before React commits the closed editor; focusing then
  // found no Edit title button. Firing frames on the next microtask makes that ordering certain.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    queueMicrotask(() => cb(0));
    return 0;
  });
  const api = world();
  api.on("PATCH /api/tasks/T-42", () => json({ task: detail({ title: "New title" }) }));
  renderApp("/tasks/T-42", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Edit title" }));
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.getByRole("button", { name: "Edit title" })).toHaveFocus());
  await userEvent.click(screen.getByRole("button", { name: "Edit title" }));
  await userEvent.clear(screen.getByLabelText("Title"));
  await userEvent.type(screen.getByLabelText("Title"), "New title{Enter}");
  await screen.findByRole("heading", { level: 2, name: "New title" });
  await waitFor(() => expect(screen.getByRole("button", { name: "Edit title" })).toHaveFocus());
});

test("description edit: Escape does not cancel; a failure keeps the text; Save then Cancel return focus to Edit description", async () => {
  const api = world();
  let fail = true;
  api.on("PATCH /api/tasks/T-42", () =>
    fail
      ? json({ error: { code: "x", message: "boom" } }, 500)
      : json({ task: detail({ body: "Changed" }) }),
  );
  renderApp("/tasks/T-42", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Edit description" }));
  const area = screen.getByRole("textbox", { name: "Description" });
  expect(area).toHaveFocus();
  expect(screen.getByText("Saving sends the new description to @dev.")).toBeInTheDocument();
  await userEvent.clear(area);
  await userEvent.type(area, "Changed");
  await userEvent.keyboard("{Escape}");
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue("Changed");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("Couldn't save. Try again.")).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue("Changed");
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("Changed")).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Edit description" })).toHaveFocus(),
  );
});

test("an empty body says so and offers Add a description", async () => {
  world(() => detail({ body: "" }));
  renderApp("/tasks/T-42", alice);
  expect(await screen.findByText("No description.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Add a description" })).toBeInTheDocument();
});

test("Reply puts the author's mention at the start of the composer and focuses it", async () => {
  world();
  renderApp("/tasks/T-42", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Reply to @dev" }));
  const box = screen.getByRole("textbox", { name: "Comment" });
  await waitFor(() => expect(box).toHaveFocus());
  expect(box).toHaveValue("@dev ");
  await userEvent.click(screen.getByRole("button", { name: "Reply to @dev" }));
  expect(box).toHaveValue("@dev ");
});

test("composer: disabled while empty, Ctrl-Enter posts, Posting…, the draft stays on failure, the helper names the assignee", async () => {
  const api = world();
  let fail = true;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  api.on("POST /api/tasks/T-42/comments", async () => {
    await gate;
    return fail
      ? json({ error: { code: "x", message: "boom" } }, 500)
      : json(
          {
            comment: {
              type: "comment",
              id: "c9",
              author: { kind: "user", handle: "alice" },
              body: "ok",
              at: at(15, 0),
            },
            deliveredTo: ["dev"],
            mentionedHumans: [],
            notReached: [
              { name: "nobody", reason: "unknown" },
              { name: "kid", reason: "terminated" },
            ],
          },
          201,
        );
  });
  renderApp("/tasks/T-42", alice);
  const send = await screen.findByRole("button", { name: "Comment" });
  expect(send).toBeDisabled();
  const box = screen.getByRole("textbox", { name: "Comment" });
  expect(box).toHaveAccessibleDescription("Goes to @dev and anyone you @mention.");
  await userEvent.type(box, "hello @nobody");
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  expect(await screen.findByRole("button", { name: "Posting…" })).toBeDisabled();
  release();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn't post the comment. Try again.",
  );
  expect(box).toHaveValue("hello @nobody");
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "Comment" }));
  expect(
    await screen.findByText("Not reached: @nobody (no such name), @kid (terminated)."),
  ).toBeInTheDocument();
  expect(box).toHaveValue("");
});

test("no assignee: the helper says only mentions are notified", async () => {
  world(() => detail({ assignee: null }));
  renderApp("/tasks/T-42", alice);
  expect(
    await screen.findByText("No assignee: only the people and agents you @mention are notified."),
  ).toBeInTheDocument();
});

test("?comment=<id> of an agent's comment: highlighted, focused, composer prefilled; of a human's: no prefill; unknown: a muted line", async () => {
  world(() =>
    detail({
      activity: [
        {
          type: "comment",
          id: "c1",
          author: { kind: "agent", slug: "dev" },
          body: "from agent",
          at: at(9, 14),
        },
        {
          type: "comment",
          id: "c2",
          author: { kind: "user", handle: "sam" },
          body: "from human",
          at: at(9, 16),
        },
      ],
    }),
  );
  const first = renderApp("/tasks/T-42?comment=c1", alice);
  const article = await screen.findByRole("article", { name: "Comment from @dev" });
  await waitFor(() => expect(article).toHaveFocus());
  expect(article).toHaveAttribute("data-highlighted", "true");
  expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("@dev ");
  first.unmount();
  const second = renderApp("/tasks/T-42?comment=c2", alice);
  const human = await screen.findByRole("article", { name: "Comment from @sam" });
  await waitFor(() => expect(human).toHaveFocus());
  expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("");
  second.unmount();
  renderApp("/tasks/T-42?comment=nope", alice);
  expect(await screen.findByText("Comment not found. Showing the task.")).toBeInTheDocument();
});

test("an unknown task is 'Task not found.' with its key and a way back", async () => {
  mockApi({
    "GET /api/agents?": agents,
    "GET /api/tasks/T-999": () =>
      json({ error: { code: "task_not_found", message: "No task T-999." } }, 404),
  });
  renderApp("/tasks/T-999", alice);
  expect(await screen.findByText("Task not found.")).toBeInTheDocument();
  expect(screen.getByText("No task T-999.")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Back to tasks" })).toHaveAttribute("href", "/tasks");
});

test("tasks_changed refetches the open task and keeps the draft and an open editor", async () => {
  let current = detail();
  world(() => current);
  renderApp("/tasks/T-42", alice);
  await userEvent.type(await screen.findByRole("textbox", { name: "Comment" }), "my draft");
  await userEvent.click(screen.getByRole("button", { name: "Edit description" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Description" }), " more");
  current = detail({
    status: "done",
    activity: [
      ...detail().activity,
      {
        type: "comment",
        id: "c5",
        author: { kind: "agent", slug: "dev" },
        body: "done now",
        at: at(9, 40),
      },
    ],
  });
  act(() => ws.push({ type: "tasks_changed", keys: ["T-42"] }));
  expect(await screen.findByRole("button", { name: "Status: Done" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("my draft");
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue("The **brief**. more");
  expect(await screen.findByText("@dev commented")).toBeInTheDocument();
});

test("a save wins over an older detail fetch still in flight", async () => {
  let held: ((r: Response) => void) | undefined;
  let gets = 0;
  const api = world();
  api.on("GET /api/tasks/T-42", () => {
    gets += 1;
    if (gets === 1) return json(detail());
    return new Promise<Response>((res) => {
      held = res;
    });
  });
  api.on("PATCH /api/tasks/T-42", () => json({ task: detail({ title: "New" }) }));
  renderApp("/tasks/T-42", alice);
  await screen.findByRole("heading", { level: 2, name: "Plan the billing migration" });
  act(() => ws.push({ type: "tasks_changed", keys: ["T-42"] })); // starts the GET that stays open
  await waitFor(() => expect(held).toBeDefined());
  await userEvent.click(screen.getByRole("button", { name: "Edit title" }));
  await userEvent.clear(screen.getByLabelText("Title"));
  await userEvent.type(screen.getByLabelText("Title"), "New{Enter}");
  await screen.findByRole("heading", { level: 2, name: "New" });
  await act(async () => held?.(json(detail({ title: "Old" }))));
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.getByRole("heading", { level: 2, name: "New" })).toBeInTheDocument();
});

test("dependencies, blocks and links are listed; blocked marker; editing links validates", async () => {
  const api = world(() =>
    detail({
      blockedBy: ["T-41"],
      dependsOn: [{ key: "T-41", title: "Add usage export", status: "open", blocked: false }],
      blocks: [{ key: "T-43", title: "Ship v2", status: "open", blocked: true, assignee: null }],
      links: [
        { kind: "pr", target: "https://github.com/acme/app/pull/12", title: "The PR" },
        { kind: "file", target: "docs/plan.md" },
        { kind: "agent", agent: { slug: "dev", displayName: "Dev", ended: "terminated" } },
      ],
    }),
  );
  api.on("PATCH /api/tasks/T-42", () => json({ task: detail() }));
  renderApp("/tasks/T-42", alice);
  expect(await screen.findByRole("link", { name: "Task T-41: Add usage export" })).toHaveAttribute(
    "href",
    "/tasks/T-41",
  );
  expect(screen.getByText("Blocked")).toBeInTheDocument();
  const pr = screen.getByRole("link", { name: /The PR/ });
  expect(pr).toHaveAttribute("href", "https://github.com/acme/app/pull/12");
  expect(pr).toHaveAttribute("target", "_blank");
  expect(screen.getByText("docs/plan.md")).toHaveClass("font-mono");
  await userEvent.click(screen.getByRole("button", { name: "Edit links" }));
  const target = screen.getByLabelText("Link 1 target");
  await userEvent.clear(target);
  await userEvent.type(target, "javascript:alert(1)");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("Links must be http(s) URLs.")).toBeInTheDocument();
  expect(patches(api)).toHaveLength(0);
});

test("agent text is inert: scripts, image handlers and javascript: links never render live; a title is plain text", async () => {
  const evil =
    "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))";
  world(() =>
    detail({
      title: "<b>x</b>",
      body: evil,
      activity: [
        {
          type: "comment",
          id: "c1",
          author: { kind: "agent", slug: "dev" },
          body: evil,
          at: at(9, 14),
        },
      ],
    }),
  );
  const { container } = renderApp("/tasks/T-42", alice);
  expect(await screen.findByRole("heading", { level: 2, name: "<b>x</b>" })).toBeInTheDocument();
  await screen.findByRole("article", { name: "Comment from @dev" });
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("h2 b")).toBeNull();
  for (const a of container.querySelectorAll("a"))
    expect(a.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
});

test("the usage line and its lower-bound hint show when the task has usage, and are absent when null", async () => {
  world(() => detail({ usage: { costUsd: 1.23, turns: 14 } }));
  renderApp("/tasks/T-42", alice);
  expect(await screen.findByText("Usage: $1.23 est. · 14 turns")).toBeInTheDocument();
  expect(
    screen.getByText(
      "Counts only turns that handled this task's messages and nothing else. Real usage can be higher.",
    ),
  ).toBeInTheDocument();
});

test("no usage line when the task has no attributed usage", async () => {
  world();
  renderApp("/tasks/T-42", alice);
  await screen.findByText("Plan the billing migration");
  expect(screen.queryByText(/^Usage:/)).toBeNull();
});
