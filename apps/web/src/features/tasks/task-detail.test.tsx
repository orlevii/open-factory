import type { ServerMessage } from "@open-factory/shared";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TOASTER_LABEL } from "@/components/ui/toaster";
import { readDraft, taskDraftKey } from "@/lib/drafts";
import { FORM_MSG } from "@/lib/form-messages";
import taskRouteSource from "@/routes/_app/tasks.$key.tsx?raw";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { agentSummary } from "@/test/session-fixtures";
import taskDetailSource from "./task-detail.tsx?raw";

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
  await userEvent.click(await screen.findByRole("combobox", { name: "Assignee: @dev" }));
  await userEvent.click(await screen.findByRole("option", { name: /QA\s*@qa/ }));
  expect(await screen.findByText("Assigned to @qa")).toBeInTheDocument();
  expect(patches(api)[0]?.body).toEqual({ assignee: "qa" });
  fail = true;
  await userEvent.click(screen.getByRole("combobox", { name: "Assignee: @qa" }));
  await userEvent.click(await screen.findByRole("option", { name: /Dev\s*@dev/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "@qa was terminated and can't be assigned tasks.",
  );
  expect(screen.getByRole("combobox", { name: "Assignee: @qa" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("combobox", { name: "Assignee: @qa" }));
  await userEvent.click(await screen.findByRole("option", { name: "Unassigned" }));
  await waitFor(() => expect(patches(api).at(-1)?.body).toEqual({ assignee: null }));
});

test("Assignee picker: typeahead matches the slug, arrows only move the highlight, Enter assigns", async () => {
  const api = world();
  renderApp("/tasks/T-42", alice);
  const trigger = await screen.findByRole("combobox", { name: "Assignee: @dev" });
  trigger.focus();
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("option", { name: /QA\s*@qa/ });
  await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowUp}");
  await userEvent.type(screen.getByRole("combobox", { name: "Search" }), "qa");
  await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2)); // Unassigned stays
  await waitFor(() =>
    expect(screen.getByRole("option", { name: /QA/ })).toHaveAttribute("aria-selected", "true"),
  );
  expect(patches(api)).toHaveLength(0);
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(patches(api)[0]?.body).toEqual({ assignee: "qa" }));
});

test("focus stays on the status menu while a change saves and after it lands", async () => {
  const api = world();
  let land = () => {};
  api.on(
    "PATCH /api/tasks/T-42",
    () =>
      new Promise<Response>((resolve) => {
        land = () => resolve(json({ task: detail({ status: "done" }) }));
      }),
  );
  renderApp("/tasks/T-42", alice);
  const trigger = await screen.findByRole("button", { name: "Status: In progress" });
  trigger.focus();
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("menuitemradio", { name: "Done" });
  await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
  await waitFor(() => expect(patches(api)).toHaveLength(1));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  const busy = screen.getByRole("button", { name: "Status: Done" });
  expect(busy).toHaveFocus();
  expect(busy).toHaveAttribute("aria-disabled", "true");
  await userEvent.keyboard("{Enter}");
  expect(screen.queryByRole("menu")).toBeNull();
  act(() => land());
  expect(await screen.findByText("Status set to done")).toBeInTheDocument();
  const settled = screen.getByRole("button", { name: "Status: Done" });
  expect(settled).toHaveFocus();
  expect(settled).not.toHaveAttribute("aria-disabled");
});

test("focus stays on the assignee picker while a change saves and after it lands", async () => {
  const api = world();
  let land = () => {};
  api.on(
    "PATCH /api/tasks/T-42",
    () =>
      new Promise<Response>((resolve) => {
        land = () =>
          resolve(json({ task: detail({ assignee: { slug: "qa", displayName: "QA" } }) }));
      }),
  );
  renderApp("/tasks/T-42", alice);
  const trigger = await screen.findByRole("combobox", { name: "Assignee: @dev" });
  trigger.focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.type(await screen.findByRole("combobox", { name: "Search" }), "qa");
  await waitFor(() =>
    expect(screen.getByRole("option", { name: /QA/ })).toHaveAttribute("aria-selected", "true"),
  );
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(patches(api)).toHaveLength(1));
  // Pending: the popover has closed and handed focus back to its trigger, which can't open again.
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  const busy = screen.getByRole("combobox", { name: "Assignee: @qa" });
  expect(busy).toHaveFocus();
  expect(busy).toHaveAttribute("aria-disabled", "true");
  await userEvent.keyboard("{Enter}");
  expect(screen.queryByRole("listbox")).toBeNull();
  act(() => land());
  expect(await screen.findByText("Assigned to @qa")).toBeInTheDocument();
  const settled = screen.getByRole("combobox", { name: "Assignee: @qa" });
  expect(settled).toHaveFocus();
  expect(settled).not.toHaveAttribute("aria-disabled");
});

test("an ended assignee shows muted above a 'Choose an agent…' trigger", async () => {
  world(() => detail({ assignee: { slug: "dev", displayName: "Dev", ended: "terminated" } }));
  renderApp("/tasks/T-42", alice);
  expect(
    await screen.findByRole("combobox", { name: "Assignee: Choose an agent…" }),
  ).toBeInTheDocument();
  expect(
    screen.getByText((_, el) => el?.tagName === "P" && el.textContent === "@dev · terminated"),
  ).toBeInTheDocument();
});

test("an ended assignee can still be unassigned", async () => {
  const api = world(() =>
    detail({ assignee: { slug: "dev", displayName: "Dev", ended: "terminated" } }),
  );
  api.on("PATCH /api/tasks/T-42", () => json({ task: detail({ assignee: null }) }));
  renderApp("/tasks/T-42", alice);
  await userEvent.click(
    await screen.findByRole("combobox", { name: "Assignee: Choose an agent…" }),
  );
  await userEvent.click(await screen.findByRole("option", { name: "Unassigned" }));
  await waitFor(() => expect(patches(api).at(-1)?.body).toEqual({ assignee: null }));
});

test("Escape and clicking away leave the assignee unchanged", async () => {
  const api = world();
  renderApp("/tasks/T-42", alice);
  const trigger = await screen.findByRole("combobox", { name: "Assignee: @dev" });
  await userEvent.click(trigger);
  await screen.findByRole("listbox");
  await userEvent.keyboard("{ArrowDown}{Escape}");
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  await userEvent.click(trigger);
  await screen.findByRole("listbox");
  await userEvent.click(document.body);
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  expect(patches(api)).toHaveLength(0);
  expect(trigger).toHaveAccessibleName("Assignee: @dev");
});

test("Edit beside the title is an outline button (§6.3)", async () => {
  world();
  renderApp("/tasks/T-42", alice);
  expect(await screen.findByRole("button", { name: "Edit title" })).toHaveAttribute(
    "data-variant",
    "outline",
  );
});

test("an inline editor's Cancel is ghost: it acts inside the section (decision 20)", async () => {
  world();
  renderApp("/tasks/T-42", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Edit title" }));
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveAttribute("data-variant", "ghost");
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

test("title editor: an empty title on Save shows in the title's note, not the outcome line, and focuses the input", async () => {
  const api = world();
  renderApp("/tasks/T-42", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Edit title" }));
  const input = screen.getByLabelText("Title");
  await userEvent.clear(input);
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(input).toHaveAttribute("aria-invalid", "true"));
  expect(input).toHaveAccessibleDescription("Enter a title.");
  expect(document.getElementById("field-task-title-error")).toHaveAttribute("data-shown");
  expect(input).toHaveFocus();
  expect(screen.getByRole("alert")).toBeEmptyDOMElement();
  expect(patches(api)).toHaveLength(0);
  // A fix clears it as you type.
  await userEvent.type(input, "Back");
  expect(input).not.toHaveAttribute("aria-invalid");
});

test("title editor: a save failure takes the outcome line over the hint; the next edit brings the hint back", async () => {
  const api = world();
  api.on("PATCH /api/tasks/T-42", () => json({ error: { code: "x", message: "boom" } }, 500));
  renderApp("/tasks/T-42", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Edit title" }));
  const hint = screen.getByText("Saving sends the new title to @dev.");
  expect(hint).toHaveAttribute("data-shown");
  expect(screen.getByRole("button", { name: "Save" })).toHaveAccessibleDescription(
    "Saving sends the new title to @dev.",
  );
  await userEvent.type(screen.getByLabelText("Title"), "!");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't save. Try again.");
  expect(hint).not.toHaveAttribute("data-shown");
  await userEvent.type(screen.getByLabelText("Title"), "?");
  expect(screen.getByRole("alert")).toBeEmptyDOMElement();
  expect(hint).toHaveAttribute("data-shown");
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveAttribute("data-skip-validate");
});

test("title editor: a server field error lands in the title's note", async () => {
  const api = world();
  api.on("PATCH /api/tasks/T-42", () =>
    json(
      {
        error: {
          code: "invalid",
          message: "Invalid.",
          fields: { title: "Use 200 characters or fewer." },
        },
      },
      400,
    ),
  );
  renderApp("/tasks/T-42", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Edit title" }));
  const input = screen.getByLabelText("Title");
  await userEvent.type(input, "!");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(input).toHaveAccessibleDescription("Use 200 characters or fewer."));
  expect(input).toHaveFocus();
  expect(screen.getByRole("alert")).toBeEmptyDOMElement();
});

test("dependencies editor: a bad key shows in its note on leave; Cancel drops it", async () => {
  world();
  renderApp("/tasks/T-42", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Edit dependencies" }));
  const deps = screen.getByLabelText("Depends on");
  await userEvent.type(deps, "banana");
  await userEvent.tab();
  await waitFor(() => expect(deps).toHaveAttribute("aria-invalid", "true"));
  expect(deps).toHaveAccessibleDescription("Use task keys, like T-41.");
  expect(document.getElementById("field-task-depends-on-error")).toHaveAttribute("data-shown");
  expect(screen.getByRole("alert")).toBeEmptyDOMElement();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await userEvent.click(await screen.findByRole("button", { name: "Edit dependencies" }));
  expect(screen.getByLabelText("Depends on")).not.toHaveAttribute("aria-invalid");
});

test("dependencies editor: the resolved badges render below the editor", async () => {
  mockApi({
    "GET /api/agents?": agents,
    "GET /api/tasks/T-42": () => json(detail()),
    "GET /api/tasks?": (_b, url) =>
      json({
        tasks: url.includes("keys=")
          ? [
              {
                key: "T-41",
                title: "Add usage export",
                status: "open",
                assignee: null,
                blockedBy: [],
                createdBy: { kind: "user", handle: "or" },
                updatedAt: at(9, 0),
              },
            ]
          : [],
        nextCursor: null,
      }),
  });
  renderApp("/tasks/T-42", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Edit dependencies" }));
  const deps = screen.getByLabelText("Depends on");
  await userEvent.type(deps, "T-41");
  await userEvent.tab();
  const list = await screen.findByRole("list", { name: "Resolved dependencies" });
  expect(within(list).getByText("Add usage export")).toBeInTheDocument();
  const note = document.getElementById("field-task-depends-on-help") as HTMLElement;
  expect(note).toHaveTextContent("Depends on T-41.");
  // Below the field (its note included), above the buttons.
  expect(note.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const save = screen.getByRole("button", { name: "Save" });
  expect(list.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

const t41 = {
  key: "T-41",
  title: "Add usage export",
  status: "open",
  assignee: null,
  blockedBy: [],
  createdBy: { kind: "user", handle: "or" },
  updatedAt: at(9, 0),
};
const invalid = (fields: Record<string, string>) =>
  json({ error: { code: "invalid", message: "Invalid.", fields } }, 400);

test("dependencies editor: Cancel while the Save lookup is pending sends nothing", async () => {
  const releases: (() => void)[] = [];
  const api = world();
  api.on("GET /api/tasks?", async (_b, url) => {
    if (!url.includes("keys=")) return json({ tasks: [], nextCursor: null });
    await new Promise<void>((r) => releases.push(r));
    return json({ tasks: [t41], nextCursor: null });
  });
  api.on("PATCH /api/tasks/T-42", () => json({ task: detail() }));
  renderApp("/tasks/T-42", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Edit dependencies" }));
  await userEvent.type(screen.getByLabelText("Depends on"), "T-41");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(await screen.findByRole("button", { name: "Edit dependencies" })).toBeInTheDocument();
  // The blur's lookup and Save's both answer after the editor is gone.
  await act(async () => {
    for (const r of releases) r();
  });
  await act(async () => {});
  expect(patches(api)).toHaveLength(0);
});

test("dependencies editor: the server's cycle sentence lands in the Depends-on note and focuses it", async () => {
  const cycle = "T-41 already depends on T-42; that would make a cycle.";
  const api = world();
  api.on("GET /api/tasks?", (_b, url) =>
    json({ tasks: url.includes("keys=") ? [t41] : [], nextCursor: null }),
  );
  api.on("PATCH /api/tasks/T-42", () => invalid({ dependsOn: cycle }));
  renderApp("/tasks/T-42", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Edit dependencies" }));
  const deps = screen.getByLabelText("Depends on");
  await userEvent.type(deps, "T-41");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(deps).toHaveAccessibleDescription(cycle));
  expect(deps).toHaveAttribute("aria-invalid", "true");
  expect(deps).toHaveFocus();
  expect(screen.getByRole("alert")).toBeEmptyDOMElement();
});

test("dependencies editor: a failed lookup on Save says so in the outcome line and sends nothing", async () => {
  const api = world();
  api.on("GET /api/tasks?", (_b, url) =>
    url.includes("keys=")
      ? json({ error: { code: "internal", message: "Boom." } }, 500)
      : json({ tasks: [], nextCursor: null }),
  );
  renderApp("/tasks/T-42", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Edit dependencies" }));
  await userEvent.type(screen.getByLabelText("Depends on"), "T-41");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(FORM_MSG.saveFailed));
  expect(patches(api)).toHaveLength(0);
});

test("links editor: a server links error with no rows takes the outcome line", async () => {
  const api = world();
  api.on("PATCH /api/tasks/T-42", () => invalid({ links: "Too many links." }));
  renderApp("/tasks/T-42", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Edit links" }));
  const save = screen.getByRole("button", { name: "Save" });
  await waitFor(() => expect(save).toBeEnabled());
  await userEvent.click(save);
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Too many links."));
});

test("links editor: a server links error with rows lands in the first row's note", async () => {
  const api = world(() =>
    detail({
      links: [
        { kind: "file", target: "docs/plan.md" },
        { kind: "file", target: "docs/spec.md" },
      ],
    }),
  );
  api.on("PATCH /api/tasks/T-42", () => invalid({ links: "Too many links." }));
  renderApp("/tasks/T-42", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Edit links" }));
  const save = screen.getByRole("button", { name: "Save" });
  await waitFor(() => expect(save).toBeEnabled());
  await userEvent.click(save);
  const first = screen.getByLabelText("Link 1 target");
  await waitFor(() => expect(first).toHaveAccessibleDescription("Too many links."));
  expect(screen.getByLabelText("Link 2 target")).not.toHaveAttribute("aria-invalid");
  expect(screen.getByRole("alert")).toBeEmptyDOMElement();
});

test("links editor: a bad row's message sits in that row's note, under its target", async () => {
  const api = world(() => detail({ links: [{ kind: "file", target: "docs/plan.md" }] }));
  renderApp("/tasks/T-42", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Edit links" }));
  await userEvent.click(screen.getByRole("button", { name: "Add link" }));
  const target = screen.getByLabelText("Link 2 target");
  await userEvent.type(target, "javascript:alert(1)");
  await userEvent.tab();
  await waitFor(() => expect(target).toHaveAttribute("aria-invalid", "true"));
  expect(target).toHaveAccessibleDescription("Links must be http(s) URLs.");
  expect(screen.getByLabelText("Link 1 target")).not.toHaveAttribute("aria-invalid");
  const note = document.getElementById(target.getAttribute("aria-describedby") ?? "");
  // The note shares the target's row.
  expect(note?.closest(".grid")).toBe(target.parentElement);
  await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(target).toHaveFocus());
  expect(screen.getByRole("alert")).toBeEmptyDOMElement();
  expect(patches(api)).toHaveLength(0);
});

test("description editor: an over-long body on Save from Preview goes back to Write, marks the frame and focuses the textarea", async () => {
  const api = world();
  renderApp("/tasks/T-42", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Edit description" }));
  const area = screen.getByRole("textbox", { name: "Description" });
  fireEvent.change(area, { target: { value: "x".repeat(70_000) } });
  const frame = area.closest("[data-slot=tabs]") as HTMLElement;
  await userEvent.click(within(frame).getByRole("tab", { name: "Preview" }));
  expect(screen.queryByRole("textbox", { name: "Description" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  const back = await screen.findByRole("textbox", { name: "Description" });
  await waitFor(() => expect(back).toHaveFocus());
  expect(back).toHaveAttribute("aria-invalid", "true");
  expect(back).toHaveAccessibleDescription("Shorten this to 64 KB or less.");
  expect(frame).toHaveAttribute("data-invalid");
  expect(patches(api)).toHaveLength(0);
});

test("description editor: leaving an edited, invalid body for Cancel doesn't validate it; leaving it for Save does", async () => {
  world();
  renderApp("/tasks/T-42", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Edit description" }));
  const area = screen.getByRole("textbox", { name: "Description" });
  fireEvent.change(area, { target: { value: "x".repeat(70_000) } });
  // A keyboard move: the blur's relatedTarget is Cancel, with no pointerdown to fall back on.
  act(() => screen.getByRole("button", { name: "Cancel" }).focus());
  expect(area).not.toHaveAttribute("aria-invalid");
  act(() => area.focus());
  act(() => screen.getByRole("button", { name: "Save" }).focus());
  expect(area).toHaveAttribute("aria-invalid", "true");
  expect(area).toHaveAccessibleDescription("Shorten this to 64 KB or less.");
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
  const box = screen.getByRole("combobox", { name: "Comment" });
  await waitFor(() => expect(box).toHaveFocus());
  expect(box).toHaveValue("@dev ");
  await userEvent.click(screen.getByRole("button", { name: "Reply to @dev" }));
  expect(box).toHaveValue("@dev ");
});

test("composer: Send disabled while empty, Ctrl-Enter posts at once, a failure puts the text back, the helper names the assignee", async () => {
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
  const send = await screen.findByRole("button", { name: "Send" });
  expect(send).toBeDisabled();
  const box = screen.getByRole("combobox", { name: "Comment" });
  expect(box).toHaveAccessibleDescription("Goes to @dev and anyone you @mention. Enter to post.");
  await userEvent.type(box, "hello @nobody");
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  // Optimistic (U3 §13.2): the box empties at once; the draft keeps the text until the server takes it.
  expect(box).toHaveValue("");
  expect(send).toBeDisabled();
  release();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn't post the comment. Try again.",
  );
  expect(box).toHaveValue("hello @nobody");
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(
    await screen.findByText("Not reached: @nobody (no such name), @kid (terminated)."),
  ).toBeInTheDocument();
  expect(box).toHaveValue("");
});

const posted = (body: string) =>
  json(
    {
      comment: {
        type: "comment",
        id: `c-${body}`,
        author: { kind: "user", handle: "alice" },
        body,
        at: at(15, 0),
      },
      deliveredTo: [],
      mentionedHumans: [],
      notReached: [],
    },
    201,
  );

test("composer: text typed while a post is in flight survives it; the posted part goes", async () => {
  const api = world();
  let release: () => void = () => {};
  api.on("POST /api/tasks/T-42/comments", async () => {
    await new Promise<void>((r) => (release = r));
    return posted("a");
  });
  renderApp("/tasks/T-42", alice);
  const box = await screen.findByRole("combobox", { name: "Comment" });
  await userEvent.type(box, "a");
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  await waitFor(() => expect(api.calls.some((c) => c.method === "POST")).toBe(true));
  await userEvent.type(box, "b");
  await act(async () => release());
  // The posted part leaves the stored draft; what was typed since stays, in the box and the draft.
  await waitFor(() => expect(readDraft(taskDraftKey("T-42"))).toBe("b"));
  expect(box).toHaveValue("b");
});

test("composer: with nothing typed during the post the draft clears", async () => {
  const api = world();
  api.on("POST /api/tasks/T-42/comments", () => posted("a"));
  renderApp("/tasks/T-42", alice);
  const box = await screen.findByRole("combobox", { name: "Comment" });
  await userEvent.type(box, "a");
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  await waitFor(() => expect(box).toHaveValue(""));
});

test("composer: a throwing localStorage (private mode) neither breaks typing nor posting", async () => {
  const blocked = () => {
    throw new DOMException("blocked", "SecurityError");
  };
  vi.stubGlobal("localStorage", {
    getItem: blocked,
    setItem: blocked,
    removeItem: blocked,
    clear: blocked,
    key: blocked,
    length: 0,
  });
  const api = world();
  api.on("POST /api/tasks/T-42/comments", () => posted("hello"));
  renderApp("/tasks/T-42", alice);
  const box = await screen.findByRole("combobox", { name: "Comment" });
  await userEvent.type(box, "hello");
  expect(box).toHaveValue("hello");
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  await waitFor(() => expect(box).toHaveValue(""));
  expect(api.calls.some((c) => c.method === "POST" && c.url === "/api/tasks/T-42/comments")).toBe(
    true,
  );
});

test("links editor: the agent lists load on the Edit click and Save waits for them", async () => {
  const api = world(() => detail({ links: [{ kind: "file", target: "docs/plan.md" }] }));
  const releases: (() => void)[] = [];
  api.on("GET /api/agents?", async () => {
    await new Promise<void>((r) => releases.push(r));
    return agents();
  });
  renderApp("/tasks/T-42", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Edit links" }));
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  await waitFor(() => expect(releases.length).toBe(2));
  await act(async () => {
    for (const r of releases) r();
  });
  await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
});

test("links editor: when an agent list fails Save is not locked and the editor says so", async () => {
  const api = world(() => detail({ links: [{ kind: "file", target: "docs/plan.md" }] }));
  api.on("GET /api/agents?", () => json({ error: { code: "x", message: "boom" } }, 500));
  api.on("PATCH /api/tasks/T-42", () => json({ task: detail() }));
  renderApp("/tasks/T-42", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Edit links" }));
  expect(await screen.findByText(/Couldn't load agents/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
});

test("no assignee: the helper says only mentions are notified", async () => {
  world(() => detail({ assignee: null }));
  renderApp("/tasks/T-42", alice);
  expect(
    await screen.findByText(
      "No assignee: only the people and agents you @mention are notified. Enter to post.",
    ),
  ).toBeInTheDocument();
});

test("comment composer: Enter posts once, Shift+Enter adds a line", async () => {
  fakeMatchMedia.install(false);
  const api = world();
  api.on("POST /api/tasks/T-42/comments", () => posted("a"));
  renderApp("/tasks/T-42", alice);
  const box = await screen.findByRole("combobox", { name: "Comment" });
  await userEvent.type(box, "a{Shift>}{Enter}{/Shift}b");
  expect(box).toHaveValue("a\nb");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(box).toHaveValue(""));
  expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(1);
});

test("comment composer: on a coarse pointer the helper drops 'Enter to post.' and Enter adds a line", async () => {
  fakeMatchMedia.install(false, { coarse: true });
  const api = world();
  renderApp("/tasks/T-42", alice);
  const box = await screen.findByRole("combobox", { name: "Comment" });
  expect(box).toHaveAccessibleDescription("Goes to @dev and anyone you @mention.");
  await userEvent.type(box, "a{Enter}b");
  expect(box).toHaveValue("a\nb");
  expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(0);
});

test("comment composer: Enter during IME composition does not post", async () => {
  fakeMatchMedia.install(false);
  const api = world();
  renderApp("/tasks/T-42", alice);
  const box = await screen.findByRole("combobox", { name: "Comment" });
  await userEvent.type(box, "draft");
  fireEvent.keyDown(box, { key: "Enter", isComposing: true });
  fireEvent.keyDown(box, { key: "Enter", keyCode: 229 });
  expect(box).toHaveValue("draft");
  expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(0);
});

test("comment composer: Ctrl+Enter still posts on a coarse pointer", async () => {
  fakeMatchMedia.install(false, { coarse: true });
  const api = world();
  api.on("POST /api/tasks/T-42/comments", () => posted("a"));
  renderApp("/tasks/T-42", alice);
  const box = await screen.findByRole("combobox", { name: "Comment" });
  await userEvent.type(box, "a");
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  await waitFor(() => expect(box).toHaveValue(""));
  expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(1);
});

test("the task body editor's preview uses the detail look of the saved body", async () => {
  world();
  renderApp("/tasks/T-42", alice);
  await userEvent.click(await screen.findByRole("button", { name: /Edit description/ }));
  const editor = screen.getByRole("textbox", { name: "Description" });
  const frame = editor.closest("[data-slot=tabs]") as HTMLElement;
  await userEvent.click(within(frame).getByRole("tab", { name: "Preview" }));
  expect(frame.querySelector(".prose-of-detail")).not.toBeNull();
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
  // The comment's ⋯ sits inside the card's padding, off its border.
  expect(within(article).getByRole("button", { name: "Comment actions" })).toHaveClass(
    "top-1.5",
    "right-1.5",
  );
  expect(screen.getByRole("combobox", { name: "Comment" })).toHaveValue("@dev ");
  first.unmount();
  const second = renderApp("/tasks/T-42?comment=c2", alice);
  const human = await screen.findByRole("article", { name: "Comment from @sam" });
  await waitFor(() => expect(human).toHaveFocus());
  expect(screen.getByRole("combobox", { name: "Comment" })).toHaveValue("");
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
  await userEvent.type(await screen.findByRole("combobox", { name: "Comment" }), "my draft");
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
  expect(screen.getByRole("combobox", { name: "Comment" })).toHaveValue("my draft");
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

test("layout: the grid cannot be widened by long content; every grid and aside child can shrink", async () => {
  world();
  renderApp("/tasks/T-42", alice);
  await screen.findByRole("heading", { level: 1 });
  const grid = document.querySelector("aside")?.parentElement;
  expect(grid).toHaveClass(
    "grid-cols-[minmax(0,1fr)]",
    "@[45rem]/task:grid-cols-[minmax(0,1fr)_min(17.5rem,40%)]",
  );
  const aside = grid?.querySelector(":scope > aside") as HTMLElement;
  expect(aside).toBeTruthy();
  const kids = [...(grid?.children ?? []), ...aside.children];
  expect(kids.length).toBeGreaterThan(4);
  for (const k of kids) expect(k).toHaveClass("min-w-0");
  // A grid inside a column with an implicit (auto) track sizes it to its widest child's min-content (a
  // 4-column table, a 40-char assignee), so every grid on the way down declares a shrinkable track.
  const isGrid = (el: Element) => el.classList.contains("grid");
  const inner = [...kids, ...kids.flatMap((k) => [...k.children])].filter(isGrid);
  inner.push(...document.querySelectorAll(`section:not([aria-label^="${TOASTER_LABEL}"])`));
  inner.push(screen.getByRole("list", { name: "Activity" }));
  expect(inner.length).toBeGreaterThan(8);
  for (const g of inner) expect(g).toHaveClass("grid-cols-[minmax(0,1fr)]");
});

test("layout: the Status and Assignee triggers truncate instead of widening the rail", async () => {
  world();
  renderApp("/tasks/T-42", alice);
  const status = await screen.findByRole("button", { name: /^Status:/ });
  const assignee = screen.getByRole("combobox", { name: /^Assignee:/ });
  for (const b of [status, assignee]) {
    expect(b).toHaveClass("w-full", "min-w-0");
  }
  expect(status.querySelector(".truncate")).not.toBeNull();
  // The picker's value sits in a direct span the trigger truncates (`[&>span]:truncate`).
  expect(assignee.querySelector(":scope > span")).toHaveTextContent("@dev");
  expect(assignee.className).toContain("[&>span]:truncate");
});

/** The list row of T-42, as the tasks list caches it. */
const summary = () => {
  const { key, title, status, assignee, blockedBy, createdBy, updatedAt } = detail();
  return { key, title, status, assignee, blockedBy, createdBy, updatedAt };
};
/** The tasks list knows T-42; its detail GET waits for `release`. */
function cachedListWorld() {
  let release: (r: Response) => void = () => {};
  const gate = new Promise<Response>((r) => {
    release = r;
  });
  const api = mockApi({
    "GET /api/agents?": agents,
    "GET /api/tasks?": () => json({ tasks: [summary()], nextCursor: null }),
    "GET /api/tasks/T-42": () => gate.then((r) => r.clone()),
  });
  return { api, release };
}

test("with the tasks list cached, the page shows the title and status at once; nothing is editable until the detail arrives", async () => {
  const { release } = cachedListWorld();
  renderApp("/tasks", alice);
  await userEvent.click(await screen.findByRole("link", { name: /Plan the billing migration/ }));
  expect(
    await screen.findByRole("heading", { level: 2, name: "Plan the billing migration" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Status: In progress" })).toBeDisabled();
  expect(screen.getByRole("combobox", { name: /^Assignee/ })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Edit title" })).toBeDisabled();
  expect(document.querySelectorAll("[data-slot=skeleton]").length).toBeGreaterThan(0);
  expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: "Comment" })).not.toBeInTheDocument();
  expect(screen.queryByText("None")).not.toBeInTheDocument();

  release(json(detail()));
  expect(await screen.findByText("brief")).toBeInTheDocument();
  expect(document.querySelector("[data-slot=skeleton]")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Edit title" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Status: In progress" })).toBeEnabled();
  // The activity that arrived with the detail is history, not news.
  expect(screen.queryByText(/commented$/)).not.toBeInTheDocument();
});

test("the stand-in holds the layout of the empty detail: the side sections with a plate per line, the body with its Edit row", async () => {
  // Plates at the empty state's row heights, so a task with nothing in them doesn't move when the
  // detail lands (a phone stacks Activity under the side sections).
  const { release } = cachedListWorld();
  renderApp("/tasks", alice);
  await userEvent.click(await screen.findByRole("link", { name: /Plan the billing migration/ }));
  await screen.findByRole("heading", { level: 2, name: "Plan the billing migration" });
  const side = document.querySelector("aside .order-4") as HTMLElement;
  const sections = [...side.querySelectorAll("section")];
  expect(sections.map((s) => s.querySelector("h3")?.textContent)).toEqual([
    "Depends on",
    "Blocks",
    "Links",
    "Created by",
  ]);
  const plates = (s: Element) =>
    [...s.querySelectorAll("[data-slot=skeleton]")].map((p) => p.className.match(/\bh-\S+/)?.[0]);
  // "None" lines, the Edit buttons (h-6) and the Created by line (1.125rem).
  expect(sections.map(plates)).toEqual([
    ["h-[1lh]", "h-6"],
    ["h-[1lh]"],
    ["h-[1lh]", "h-6"],
    ["h-[1.125rem]"],
  ]);
  const body = document.querySelector("main .order-3") as HTMLElement;
  expect(body.lastElementChild?.querySelector("[data-slot=skeleton]")).toHaveClass("h-6");

  release(json(detail({ body: "" })));
  expect(await screen.findByRole("button", { name: "Edit dependencies" })).toBeInTheDocument();
  expect([...side.querySelectorAll("section h3")].map((h) => h.textContent)).toEqual([
    "Depends on",
    "Blocks",
    "Links",
    "Created by",
  ]);
});

test("with the tasks list cached, a task that turns out not to exist shows Task not found", async () => {
  const { release } = cachedListWorld();
  renderApp("/tasks", alice);
  await userEvent.click(await screen.findByRole("link", { name: /Plan the billing migration/ }));
  await screen.findByRole("heading", { level: 2, name: "Plan the billing migration" });
  release(json({ error: { code: "task_not_found", message: "No task T-42." } }, 404));
  expect(await screen.findByRole("heading", { name: "Task not found." })).toBeInTheDocument();
});

test("a ?comment= link opened from the cached list waits for the real activity before looking for the comment", async () => {
  const { release } = cachedListWorld();
  const { router } = renderApp("/tasks", alice);
  await screen.findByRole("link", { name: /Plan the billing migration/ });
  await act(() =>
    router.navigate({ to: "/tasks/$key", params: { key: "T-42" }, search: { comment: "c1" } }),
  );
  await screen.findByRole("heading", { level: 2, name: "Plan the billing migration" });
  release(json(detail()));
  expect(await screen.findByRole("article", { name: "Comment from @dev" })).toBeInTheDocument();
  expect(screen.queryByText("Comment not found. Showing the task.")).not.toBeInTheDocument();
});

test("an open task whose refetch says it no longer exists shows Task not found", async () => {
  // The loader didn't wait when the list was cached, so the page maps task_not_found itself; the
  // same mapping covers a background refetch of an open task.
  const api = world();
  const { queryClient } = renderApp("/tasks/T-42", alice);
  await screen.findByRole("heading", { level: 2, name: "Plan the billing migration" });
  api.on("GET /api/tasks/T-42", () =>
    json({ error: { code: "task_not_found", message: "No task T-42." } }, 404),
  );
  await act(() => queryClient.invalidateQueries({ queryKey: ["tasks", "detail", "T-42"] }));
  expect(await screen.findByRole("heading", { name: "Task not found." })).toBeInTheDocument();
});

test("an agent creator and an agent comment author link to the agent's page; a human one does not", async () => {
  world(() =>
    detail({
      createdBy: { kind: "agent", slug: "lead" },
      activity: [
        {
          type: "comment",
          id: "c1",
          author: { kind: "user", handle: "or" },
          body: "human words",
          at: at(9, 20),
        },
        {
          type: "comment",
          id: "c2",
          author: { kind: "agent", slug: "dev" },
          body: "agent words",
          at: at(9, 21),
        },
      ],
    }),
  );
  renderApp("/tasks/T-42", alice);
  const human = await screen.findByRole("article", { name: "Comment from @or" });
  expect(human.querySelector("[data-comment-author] a")).toBeNull();
  const agent = screen.getByRole("article", { name: "Comment from @dev" });
  expect(agent.querySelector("[data-comment-author] a")).toHaveAttribute(
    "href",
    "/agents/dev/chat",
  );
  expect(document.querySelector("[data-created-by] a")).toHaveAttribute(
    "href",
    "/agents/lead/chat",
  );
});

test("a human creator and comment author show as @handle without an avatar; an agent author shows its avatar", async () => {
  world(() =>
    detail({
      activity: [
        {
          type: "comment",
          id: "c1",
          author: { kind: "user", handle: "or" },
          body: "human words",
          at: at(9, 20),
        },
        {
          type: "comment",
          id: "c2",
          author: { kind: "agent", slug: "dev" },
          body: "agent words",
          at: at(9, 21),
        },
      ],
    }),
  );
  renderApp("/tasks/T-42", alice);
  const human = await screen.findByRole("article", { name: "Comment from @or" });
  expect(within(human).getByText("@or")).toBeInTheDocument();
  expect(human.querySelector("[data-comment-author] svg")).toBeNull();
  const agent = screen.getByRole("article", { name: "Comment from @dev" });
  expect(agent.querySelector("[data-comment-author] svg")).not.toBeNull();
  const created = document.querySelector("[data-created-by]") as HTMLElement;
  expect(created).toHaveTextContent("@or");
  expect(created.querySelector("svg")).toBeNull();
});

// §12: the view lays out by its own width (the page and the 30rem peek), not the viewport's. jsdom
// can't evaluate container queries, so this checks the classes; the layout is a browser check.
test("the task view is a container: its two columns answer to its own width, and the route owns the page padding", async () => {
  world();
  renderApp("/tasks/T-42", alice);
  const log = await screen.findByRole("list", { name: "Activity" });
  const root = log.closest(".\\@container\\/task");
  expect(root).not.toBeNull();
  const grid = root?.querySelector("[class*='@[45rem]/task:grid-cols-']");
  expect(grid).not.toBeNull();
  expect(grid?.contains(log)).toBe(true);
  expect(root?.querySelector("aside")?.className).toMatch(/@\[45rem\]\/task:col-start-2/);
  // No viewport breakpoint is left to fight the container one.
  expect(taskDetailSource).not.toMatch(/(^|[\s"'`])lg:/m);
  expect(taskDetailSource).not.toMatch(/\bPageBody\b/);
  // The page keeps its padding: the route wraps the view.
  expect(taskRouteSource).toMatch(/<PageBody>\s*(\{\/\*[\s\S]*?\*\/\}\s*)?<TaskDetailView/);
});
