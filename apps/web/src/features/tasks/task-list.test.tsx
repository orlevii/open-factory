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

const task = (n: number, o: Record<string, unknown> = {}) => ({
  key: `T-${n}`,
  title: `Task ${n}`,
  status: "open",
  assignee: null,
  blockedBy: [],
  createdBy: { kind: "user", handle: "or" },
  updatedAt: new Date(2026, 10, 19, 14, 32).toISOString(),
  ...o,
});
const page = (tasks: unknown[], nextCursor: string | null = null) => ({ tasks, nextCursor });
const agents = () =>
  json({
    agents: [agentSummary({ slug: "dev" }), agentSummary({ slug: "lead", displayName: "Lead" })],
    more: false,
    running: { count: 0, max: 8 },
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
          task(41, { title: "Add usage export", createdBy: { kind: "agent", slug: "lead" } }),
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
  expect(within(row).getByText("Blocked by T-41")).toBeInTheDocument();
  expect(within(row).getByText("14:32")).toBeInTheDocument();
  expect(screen.getByRole("list", { name: "Tasks" })).toBeInTheDocument();
  const open = screen.getByRole("link", { name: /^T-41, Add usage export, Open, unassigned/ });
  expect(within(open).getAllByText("Unassigned").length).toBeGreaterThan(0);
  expect(within(open).getByText("@lead")).toBeInTheDocument();
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
  await userEvent.selectOptions(screen.getByLabelText("Status"), "done");
  await waitFor(() => expect(router.state.location.search).toMatchObject({ status: "done" }));
  await waitFor(() => expect(tasksUrls(api).at(-1)).toBe("/api/tasks?limit=50&status=done"));
  await userEvent.selectOptions(screen.getByLabelText("Assignee"), "Unassigned");
  await waitFor(() => expect(tasksUrls(api).at(-1)).toContain("unassigned=true"));
  await userEvent.selectOptions(screen.getByLabelText("Created by"), "Me");
  await waitFor(() => expect(tasksUrls(api).at(-1)).toContain("creator=me"));
  expect(
    within(screen.getByLabelText("Created by"))
      .getAllByRole("option")
      .map((o) => o.textContent),
  ).toEqual(["Anyone", "Me", "@dev", "@lead"]);
});

test("filters from the URL are applied and an ended assignee shows while selected", async () => {
  const api = mockApi({
    "GET /api/agents?": agents,
    "GET /api/tasks?": () => json(page([task(1)])),
  });
  renderApp("/tasks?status=all&assignee=ghost&creator=@sam", alice);
  await screen.findByRole("link", { name: /^T-1,/ });
  expect(tasksUrls(api)[0]).toBe("/api/tasks?limit=50&status=all&assignee=ghost&creator=%40sam");
  expect(screen.getByLabelText("Assignee")).toHaveValue("ghost");
  expect(screen.getByLabelText("Created by")).toHaveValue("@sam");
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

test("tasks_changed refetches without losing focus on a row; the header action links to New task", async () => {
  let rows = [task(2), task(1)];
  mockApi({ "GET /api/agents?": agents, "GET /api/tasks?": () => json(page(rows)) });
  renderApp("/tasks", alice);
  const second = await screen.findByRole("link", { name: /^T-1,/ });
  second.focus();
  rows = [task(1, { title: "Task 1 renamed" }), task(2)];
  act(() => ws.push({ type: "tasks_changed", keys: ["T-1"] }));
  expect(await screen.findByRole("link", { name: /^T-1, Task 1 renamed/ })).toHaveFocus();
  expect(screen.getByRole("link", { name: "New task" })).toHaveAttribute("href", "/tasks/new");
  const links = within(screen.getByRole("list", { name: "Tasks" })).getAllByRole("link");
  expect(links[0]).toHaveAttribute("href", "/tasks/T-1");
});
