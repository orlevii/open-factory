import type { ServerMessage } from "@open-factory/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { closeSheet } from "@/features/sheets/sheet-store";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { comboOptionNames, pickComboOption, pickOption } from "@/test/select-helpers";
import { agentSummary } from "@/test/session-fixtures";

/** The marker's label, matched on its whole text (the keys are separate spans, so getByText(string) can't);
 *  the wrapper that also holds the icon is excluded. */
const blockedLabel = (text: string) => (_: string, el: Element | null) =>
  !!el && el.textContent === text && el.children.length > 0 && !el.querySelector("svg");

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
  act(() => closeSheet());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const task = (n: number, o: Record<string, unknown> = {}) => ({
  key: `T-${n}`,
  title: `Task ${n}`,
  status: "open",
  assignee: null,
  blockedBy: [],
  createdBy: { kind: "human", ref: "ref-or", handle: "or" },
  updatedAt: new Date(2026, 10, 19, 14, 32).toISOString(),
  ...o,
});
const page = (tasks: unknown[], nextCursor: string | null = null) => ({ tasks, nextCursor });
const agents = (_body?: unknown, url?: string) =>
  json({
    agents: url?.includes("ended=only")
      ? [agentSummary({ slug: "old", displayName: "Old", terminatedAt: "2026-11-01T00:00:00Z" })]
      : [agentSummary({ slug: "dev" }), agentSummary({ slug: "lead", displayName: "Lead" })],
    more: false,
    running: { count: 0 },
  });
const tasksUrls = (api: ReturnType<typeof mockApi>) =>
  api.calls.filter((c) => c.url.startsWith("/api/tasks?")).map((c) => c.url);

test("a row is one link with a complete name; status, assignee, blocked marker and times are shown", async () => {
  mockApi({
    "GET /api/agents?": agents,
    "GET /api/tasks?": () =>
      json(
        page([
          task(42, {
            title: "Plan the billing migration",
            status: "in_progress",
            assignee: { slug: "dev", displayName: "Dev" },
            blockedBy: ["T-41"],
          }),
          task(41, {
            title: "Add usage export",
            createdBy: { kind: "agent", ref: "ref-lead", handle: "lead" },
          }),
          task(40, { assignee: { slug: "gone", displayName: "Gone", ended: "terminated" } }),
        ]),
      ),
  });
  renderApp("/tasks", alice);
  const row = await screen.findByRole("link", {
    name: "T-42, Plan the billing migration, In progress, blocked by T-41, assigned to @dev",
  });
  expect(row).toHaveAttribute("href", "/tasks/T-42");
  expect(within(row).getByText("In progress")).toBeInTheDocument();
  expect(within(row).getByText(blockedLabel("Blocked by T-41"))).toBeInTheDocument();
  expect(within(row).getByText("14:32")).toBeInTheDocument();
  expect(screen.getByRole("list", { name: "Tasks" })).toBeInTheDocument();
  const open = screen.getByRole("link", { name: /^T-41, Add usage export, Open, unassigned/ });
  expect(within(open).getAllByText("Unassigned").length).toBeGreaterThan(0);
  expect(within(open).getByText(/^(Lead|@lead)$/)).toBeInTheDocument();
  const ended = screen.getByRole("link", { name: /^T-40.*assigned to @gone \(terminated\)/ });
  expect(ended).toHaveTextContent("terminated");
});

test("the filters live in the URL: changing Status refetches with that status", async () => {
  const api = mockApi({
    "GET /api/agents?": agents,
    "GET /api/tasks?": () => json(page([task(1)])),
  });
  const { router } = renderApp("/tasks", alice);
  await screen.findByRole("link", { name: /^T-1,/ });
  expect(tasksUrls(api)[0]).toBe("/api/tasks?limit=50");
  await pickOption(screen.getByLabelText("Status"), "Done");
  await waitFor(() => expect(router.state.location.search).toMatchObject({ status: "done" }));
  await waitFor(() => expect(tasksUrls(api).at(-1)).toBe("/api/tasks?limit=50&status=done"));
  await pickComboOption(screen.getByLabelText("Assignee"), /^Unassigned/);
  await waitFor(() => expect(tasksUrls(api).at(-1)).toContain("unassigned=true"));
  await pickComboOption(screen.getByLabelText("Created by"), /^Me$/);
  await waitFor(() => expect(tasksUrls(api).at(-1)).toContain("creator=me"));
  await pickComboOption(screen.getByLabelText("Assignee"), /Lead/);
  await waitFor(() => expect(router.state.location.search).toMatchObject({ assignee: "lead" }));
  expect(router.state.location.search).not.toHaveProperty("unassigned");
  await pickComboOption(screen.getByLabelText("Assignee"), /^Anyone/);
  await waitFor(() => expect(router.state.location.search).not.toHaveProperty("assignee"));
});

test("the assignee filter lists Anyone and Unassigned first, then live agents, then an Ended group", async () => {
  mockApi({ "GET /api/agents?": agents, "GET /api/tasks?": () => json(page([task(1)])) });
  renderApp("/tasks", alice);
  await screen.findByRole("link", { name: /^T-1,/ });
  const names = await comboOptionNames(screen.getByLabelText("Assignee"));
  expect(names.map((n) => n.replace(/(@[\w-]+)+$/, "").trim())).toEqual([
    "Anyone",
    "Unassigned",
    "Dev agent",
    "Lead",
    "Old",
  ]);
  await userEvent.click(screen.getByLabelText("Assignee"));
  expect(await screen.findByText("Ended")).toBeInTheDocument();
});

test("the creator filter lists Anyone and Me first, then agents", async () => {
  mockApi({ "GET /api/agents?": agents, "GET /api/tasks?": () => json(page([task(1)])) });
  renderApp("/tasks", alice);
  await screen.findByRole("link", { name: /^T-1,/ });
  const names = await comboOptionNames(screen.getByLabelText("Created by"));
  expect(names.map((n) => n.replace(/(@[\w-]+)+$/, "").trim())).toEqual([
    "Anyone",
    "Me",
    "Dev agent",
    "Lead",
    "Old",
  ]);
});

test("filters from the URL are applied and an ended assignee shows while selected", async () => {
  const api = mockApi({
    "GET /api/agents?": agents,
    "GET /api/tasks?": () => json(page([task(1)])),
  });
  renderApp("/tasks?status=all&assignee=ghost&creator=@sam", alice);
  await screen.findByRole("link", { name: /^T-1,/ });
  expect(tasksUrls(api)[0]).toBe("/api/tasks?limit=50&status=all&assignee=ghost&creator=%40sam");
  expect(screen.getByLabelText("Assignee")).toHaveTextContent("@ghost");
  expect(screen.getByLabelText("Created by")).toHaveTextContent("@sam");
});

test("empty on the default filter offers all tasks; then 'No tasks yet.'", async () => {
  mockApi({
    "GET /api/agents?": agents,
    "GET /api/tasks?": () => json(page([])),
  });
  const { router } = renderApp("/tasks", alice);
  expect(await screen.findByText("No open tasks.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Show all tasks" }));
  expect(await screen.findByText("No tasks yet.")).toBeInTheDocument();
  expect(router.state.location.search).toMatchObject({ status: "all" });
});

test("empty with another filter says so and Clear filters resets", async () => {
  mockApi({
    "GET /api/agents?": agents,
    "GET /api/tasks?": () => json(page([])),
  });
  const { router } = renderApp("/tasks?status=done", alice);
  expect(await screen.findByText("No tasks match these filters.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(await screen.findByText("No open tasks.")).toBeInTheDocument();
  expect(router.state.location.search).toEqual({});
});

test("load more pages by cursor; a failed page shows its line and Retry", async () => {
  let fail = true;
  const api = mockApi({
    "GET /api/agents?": agents,
    "GET /api/tasks?": (_b, url) => {
      if (url.includes("before=cur1")) {
        if (fail) return json({ error: { code: "x", message: "boom" } }, 500);
        return json(page([task(1)]));
      }
      return json(page([task(3), task(2)], "cur1"));
    },
  });
  renderApp("/tasks", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Load more" }));
  expect(await screen.findByText("Couldn't load more tasks.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("link", { name: /^T-1,/ })).toBeInTheDocument();
  expect(tasksUrls(api).at(-1)).toContain("before=cur1");
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
});

test("a failed first load shows one line and Retry", async () => {
  let ok = false;
  mockApi({
    "GET /api/agents?": agents,
    "GET /api/tasks?": () =>
      ok ? json(page([task(1)])) : json({ error: { code: "x", message: "boom" } }, 500),
  });
  renderApp("/tasks", alice);
  expect(await screen.findByText("Couldn't load tasks.")).toBeInTheDocument();
  ok = true;
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("link", { name: /^T-1,/ })).toBeInTheDocument();
});

test("tasks_changed refetches without losing focus on a row; the header action opens New task", async () => {
  let rows = [task(2), task(1)];
  mockApi({ "GET /api/agents?": agents, "GET /api/tasks?": () => json(page(rows)) });
  renderApp("/tasks", alice);
  const second = await screen.findByRole("link", { name: /^T-1,/ });
  second.focus();
  rows = [task(1, { title: "Task 1 renamed" }), task(2)];
  act(() => ws.push({ type: "tasks_changed", keys: ["T-1"] }));
  expect(await screen.findByRole("link", { name: /^T-1, Task 1 renamed/ })).toHaveFocus();
  const links = within(screen.getByRole("list", { name: "Tasks" })).getAllByRole("link");
  expect(links[0]).toHaveAttribute("href", "/tasks/T-1");
  await userEvent.click(screen.getByRole("button", { name: "New task" }));
  expect(await screen.findByRole("dialog", { name: "New task" })).toBeInTheDocument();
});

test("rows carry no nested anchors, even for an agent creator", async () => {
  mockApi({
    "GET /api/agents?": agents,
    "GET /api/tasks?": () =>
      json(
        page([
          task(41, {
            assignee: { slug: "dev", displayName: "Dev" },
            createdBy: { kind: "agent", ref: "ref-lead", handle: "lead" },
          }),
        ]),
      ),
  });
  renderApp("/tasks", alice);
  const row = await screen.findByRole("link", { name: /^T-41/ });
  expect(row.querySelector("a")).toBeNull();
});

test("the assignee shows as a chip (avatar and name), a human creator as @handle without an avatar, an ended assignee keeps its mark", async () => {
  mockApi({
    "GET /api/agents?": agents,
    "GET /api/tasks?": () =>
      json(
        page([
          task(50, { assignee: { slug: "dev", displayName: "Dev" } }),
          task(51, { assignee: { slug: "gone", displayName: "Gone", ended: "terminated" } }),
        ]),
      ),
  });
  renderApp("/tasks", alice);
  const row = await screen.findByRole("link", { name: /^T-50/ });
  const assignee = row.querySelector("[data-assignee]") as HTMLElement;
  expect(assignee).toHaveTextContent(/Dev/);
  expect(assignee.querySelector("svg")).not.toBeNull();
  const created = within(row).getByText(/created by/);
  expect(within(created).getByText("@or")).toBeInTheDocument();
  expect(created.querySelector("svg")).toBeNull();
  const ended = await screen.findByRole("link", { name: /^T-51/ });
  expect(within(ended).getByText("Gone")).toBeInTheDocument();
  expect(ended).toHaveTextContent("terminated");
});

test("a row caps the blockers at three with a count and keeps the full list in the title", async () => {
  const keys = Array.from({ length: 25 }, (_, i) => `T-${i + 15}`);
  mockApi({
    "GET /api/agents?": agents,
    "GET /api/tasks?": () =>
      json(page([task(90, { blockedBy: keys }), task(91, { blockedBy: ["T-1", "T-2", "T-3"] })])),
  });
  renderApp("/tasks", alice);
  const many = await screen.findByRole("link", { name: /^T-90,/ });
  expect(many).toHaveAccessibleName(/blocked by T-15, T-16, T-17 and 22 more,/);
  expect(many.getAttribute("aria-label")).not.toContain("T-18");
  const marker = within(many).getByText(blockedLabel("Blocked by T-15, T-16, T-17 +22 more"));
  expect(marker).toHaveAttribute("title", keys.join(", "));
  // Each key is its own span; the separator is never a standalone sibling that could orphan on a wrap.
  const keySpans = Array.from(marker.querySelectorAll("span"));
  expect(keySpans.map((k) => k.textContent)).toEqual(["T-15", "T-16", "T-17"]);
  expect(marker.nextElementSibling?.textContent ?? "").not.toBe("·");
  expect(marker.tagName).toBe("SPAN");
  const three = screen.getByRole("link", { name: /^T-91,/ });
  const all = within(three).getByText(blockedLabel("Blocked by T-1, T-2, T-3"));
  expect(all).not.toHaveAttribute("title");
  expect(three).not.toHaveTextContent("more");
});

test("a task title with a tag shows the tag's current handle in the row and its name, as plain text", async () => {
  mockApi({
    "GET /api/agents?": agents,
    "GET /api/principals": () =>
      json({
        principals: [
          {
            id: "p1",
            ref: "k7x2m9qd",
            kind: "agent",
            handle: "builder",
            name: "Builder",
            state: "live",
            avatar: null,
          },
        ],
      }),
    "GET /api/tasks?": () => json(page([task(7, { title: "Review <@k7x2m9qd> output" })])),
  });
  renderApp("/tasks", alice);
  const row = await screen.findByRole("link", {
    name: /^T-7, Review @builder output, Open/,
  });
  expect(within(row).getByText("Review @builder output")).toBeInTheDocument();
  expect(row.querySelector("a")).toBeNull();
});
