import type { AgentSummary } from "@open-factory/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { AgentTree } from "@/features/agents/agent-tree";
import { mockWorld } from "@/test/agent-screens-fixtures";
import { longPress } from "@/test/long-press";
import { refFor } from "@/test/refs";
import { alice, renderApp } from "@/test/render-app";
import { agentSummary } from "@/test/session-fixtures";

/** Which agents' chips rendered: one per AgentTreeRow render. */
const chipRenders = vi.hoisted(() => [] as string[]);
vi.mock("@/components/agent-chip", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/components/agent-chip")>();
  return {
    ...mod,
    AgentChip: (p: Parameters<typeof mod.AgentChip>[0]) => {
      chipRenders.push("agent" in p ? p.agent.ref : p.agentRef);
      return mod.AgentChip(p);
    },
  };
});

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
let pushFrame: (m: unknown) => void = () => {};
vi.mock("@/lib/ws", () => ({
  connectWs: (o: { onMessage?: (m: unknown) => void }) => {
    pushFrame = (m) => o.onMessage?.(m);
    return { close() {}, status: () => "open", send: () => true };
  },
}));
afterEach(() => vi.unstubAllGlobals());

const json = (data: unknown) =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

test("lists agents with status label, handle and the unsandboxed badge", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        agents: [agentSummary({ status: "working", turnOpen: true, template: "developer" })],
        running: { count: 0 },
      }),
    ),
  );
  renderApp("/agents", alice);
  const row = await screen.findByRole("link", { name: /Dev agent/ });
  expect(row).toHaveAttribute("href", `/agents/${refFor("dev")}/chat`);
  expect(within(row).getByText("Working")).toBeInTheDocument();
  expect(within(row).getAllByText("@dev").length).toBeGreaterThan(0);
  expect(within(row).getByText("developer")).toBeInTheDocument();
  expect(within(row).getByText("Unsandboxed")).toBeInTheDocument();
});

test("a pushed agent_status frame turns the row's Working into Idle", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        agents: [agentSummary({ status: "working", turnOpen: true })],
        running: { count: 0 },
      }),
    ),
  );
  renderApp("/agents", alice);
  const row = await screen.findByRole("link", { name: /Dev agent/ });
  expect(within(row).getByText("Working")).toBeInTheDocument();
  act(() =>
    pushFrame({
      type: "agent_status",
      agent: refFor("dev"),
      status: "idle",
      turnOpen: false,
      restartPending: false,
      restartWaitingOn: 0,
    }),
  );
  expect(await within(row).findByText("Idle")).toBeInTheDocument();
  expect(within(row).queryByText("Working")).not.toBeInTheDocument();
});

test("after principal_updated, the agent list shows the new handle", async () => {
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      calls += 1;
      return json({
        agents: [agentSummary({ handle: calls === 1 ? "dev" : "builder" })],
        running: { count: 0 },
      });
    }),
  );
  renderApp("/agents", alice);
  const row = await screen.findByRole("link", { name: /Dev agent/ });
  expect(within(row).getAllByText("@dev").length).toBeGreaterThan(0);
  act(() =>
    pushFrame({
      type: "principal_updated",
      principal: {
        id: "id-dev",
        ref: refFor("dev"),
        kind: "agent",
        handle: "builder",
        name: "Dev agent",
        state: "live",
        avatar: null,
      },
    }),
  );
  expect((await screen.findAllByText("@builder")).length).toBeGreaterThan(0);
  expect(screen.queryByText("@dev")).not.toBeInTheDocument();
});

test("a failed list says so", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 500 })),
  );
  renderApp("/agents", alice);
  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load agents.");
});

const listWith = (agents: ReturnType<typeof agentSummary>[], running = { count: 3 }) =>
  mockWorld({
    agents,
    extra: { "GET /api/agents?ended=exclude": () => json({ agents, running }) },
  });

test("Agents list: inline note priority, '3 running' before the radio pair, hidden on Ended", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 19, 10, 0));
  const until = new Date(2026, 10, 19, 14, 30).toISOString();
  const tasks = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      taskId: `t${i}`,
      description: "x",
      startedAt: until,
    }));
  listWith([
    agentSummary({
      handle: "a",
      displayName: "Disabled",
      runtimeDisabled: "The local runtime is disabled on this factory.",
      status: "rate_limited",
      rateLimitedUntil: until,
      waitingOn: { tasks: tasks(2), crons: 2 },
    }),
    agentSummary({
      handle: "b",
      displayName: "Paused",
      status: "rate_limited",
      rateLimitedUntil: until,
      rateLimitExact: false,
      waitingOn: { tasks: tasks(2), crons: 2 },
    }),
    agentSummary({
      handle: "c",
      displayName: "Exact",
      status: "rate_limited",
      rateLimitedUntil: until,
      rateLimitExact: true,
    }),
    agentSummary({ handle: "d", displayName: "Busy", waitingOn: { tasks: tasks(2), crons: 2 } }),
    agentSummary({ handle: "e", displayName: "One", waitingOn: { tasks: tasks(1), crons: 0 } }),
    agentSummary({ handle: "f", displayName: "Pinned", waitingOn: { tasks: [], crons: 1 } }),
    agentSummary({ handle: "g", displayName: "Plain" }),
  ]);
  const { router } = renderApp("/agents", alice);
  const note = async (name: string) => {
    const row = await screen.findByRole("link", { name: new RegExp(name) });
    return row.querySelector("[data-agent-note]")?.textContent ?? null;
  };
  expect(await note("Disabled")).toBe("Local runtime disabled");
  expect(await note("Paused")).toBe("retrying at 14:30");
  expect(await note("Exact")).toBe("until 14:30");
  expect(await note("Busy")).toBe("Waiting on 2 tasks");
  expect(await note("One")).toBe("Waiting on 1 task");
  expect(await note("Pinned")).toBe("1 cron");
  expect(await note("Plain")).toBeNull();
  // Plain text only: nothing interactive inside the row link.
  const busy = screen.getByRole("link", { name: /Busy/ });
  expect(within(busy).queryByRole("button")).toBeNull();

  const count = screen.getByText("3 running");
  const radios = screen.getByRole("group", { name: "Show" });
  expect(count.compareDocumentPosition(radios) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  act(() => pushFrame({ type: "supervisor", running: 4 }));
  expect(await screen.findByText("4 running")).toBeInTheDocument();

  act(() => pushFrame({ type: "supervisor", running: 0 }));
  await waitFor(() => expect(screen.queryByText(/running/)).not.toBeInTheDocument());
  act(() => pushFrame({ type: "supervisor", running: 4 }));
  expect(await screen.findByText("4 running")).toBeInTheDocument();

  await act(() => router.navigate({ to: "/agents", search: { ended: "only" } }));
  await screen.findByText("No ended agents.");
  expect(screen.queryByText(/running/)).not.toBeInTheDocument();
  vi.useRealTimers();
});

test("a terminated frame shows Terminated (no dot) at once, then the list refetches without it", async () => {
  // The refetch waits until released, so the patched row can be seen first.
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      // The sidebar's unread count is not what this test counts.
      if (!url.startsWith("/api/agents")) return json({ count: 0 });
      if (calls++ > 0) await held;
      return json({
        agents: calls > 1 ? [] : [agentSummary({ handle: "x-ab12", displayName: "X · ab12" })],
        running: { count: 0 },
      });
    }),
  );
  renderApp("/agents", alice);
  const row = await screen.findByRole("link", { name: /X · ab12/ });
  act(() =>
    pushFrame({
      type: "agent_status",
      agent: refFor("x-ab12"),
      status: "terminated",
      turnOpen: false,
      restartPending: false,
      restartWaitingOn: 0,
    }),
  );
  expect(await within(row).findByText("Terminated")).toBeInTheDocument();
  expect(row.querySelector("[data-status-dot]")).toBeNull();
  release();
  // It moves to the Ended view: the list is refetched rather than kept with an end state in it.
  await vi.waitFor(() =>
    expect(screen.queryByRole("link", { name: /X · ab12/ })).not.toBeInTheDocument(),
  );
});

test("?focus scrolls that agent's row into view and marks it for the visit", async () => {
  const scrolled: Element[] = [];
  vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
    scrolled.push(this);
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        agents: [
          agentSummary({ handle: "lead", displayName: "Lead agent" }),
          agentSummary({ handle: "other", displayName: "Other agent" }),
        ],
        running: { count: 0 },
      }),
    ),
  );
  renderApp(`/agents?focus=${refFor("lead")}`, alice);
  const main = await screen.findByRole("main");
  const lead = await within(main).findByRole("link", { name: /Lead agent/ });
  await waitFor(() => expect(scrolled.some((el) => lead.contains(el) || el === lead)).toBe(true));
  expect(lead).toHaveAttribute("data-focused");
  expect(within(main).getByRole("link", { name: /Other agent/ })).not.toHaveAttribute(
    "data-focused",
  );
});

const menuLayout = (menu: HTMLElement) =>
  [...menu.querySelectorAll('[role="menuitem"], [role="separator"]')].map((el) =>
    el.getAttribute("role") === "separator" ? "—" : el.textContent?.trim(),
  );

test("each Agents row has a ⋯ beside its link that opens the agent's menu", async () => {
  mockWorld({ agents: [agentSummary()] });
  renderApp("/agents", alice);
  const main = await screen.findByRole("main");
  const more = await within(main).findByRole("button", { name: "Actions for Dev agent" });
  // A sibling of the row's link, never inside it.
  expect(more.closest("a")).toBeNull();
  expect(
    more.closest("li")?.querySelector(`a[href="/agents/${refFor("dev")}/chat"]`),
  ).not.toBeNull();
  await userEvent.click(more);
  const menu = await screen.findByRole("menu");
  // The full layout is pinned in agent-menu.test.tsx; here: it is this agent's menu.
  expect(within(menu).getByRole("menuitem", { name: "Archive…" })).toBeInTheDocument();
  expect(within(menu).getByRole("menuitem", { name: "Usage" })).toHaveAttribute(
    "href",
    `/agents/${refFor("dev")}/usage`,
  );
});

test("Ended view: an archived row's menu restores it and toasts; a terminated row offers only Usage and Open tasks", async () => {
  const api = mockWorld({
    agents: [],
    archived: [
      agentSummary({ handle: "old", displayName: "Old one", archivedAt: "2026-11-01T10:00:00Z" }),
      agentSummary({
        handle: "gone",
        displayName: "Gone one",
        status: "terminated",
        terminatedAt: "2026-11-02T10:00:00Z",
      }),
    ],
    extra: {
      [`POST /api/agents/${refFor("old")}/unarchive`]: () =>
        new Response(JSON.stringify({ agent: agentSummary({ handle: "old" }) }), {
          headers: { "content-type": "application/json" },
        }),
    },
  });
  renderApp("/agents?ended=only", alice);
  const main = await screen.findByRole("main");
  const u = userEvent.setup();
  await u.click(await within(main).findByRole("button", { name: "Actions for Gone one" }));
  expect(menuLayout(await screen.findByRole("menu"))).toEqual(["Usage", "Open tasks"]);
  await u.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await u.click(within(main).getByRole("button", { name: "Actions for Old one" }));
  const menu = await screen.findByRole("menu");
  expect(menuLayout(menu)).toEqual([
    "Configure",
    "Usage",
    "Open tasks",
    "—",
    "Reset persona…",
    "Restore",
  ]);
  await u.click(within(menu).getByRole("menuitem", { name: "Restore" }));
  expect(await screen.findByText("Restored @old.")).toBeInTheDocument();
  expect(
    api.calls.some(
      (c) => c.method === "POST" && c.url === `/api/agents/${refFor("old")}/unarchive`,
    ),
  ).toBe(true);
});

test("/agents?unknownKey=1 loads the page normally", async () => {
  mockWorld({ agents: [agentSummary()] });
  renderApp("/agents?unknownKey=1", alice);
  const main = await screen.findByRole("main");
  expect(await within(main).findByRole("link", { name: /Dev agent/ })).toBeInTheDocument();
  expect(screen.getByRole("heading", { level: 1, name: "Agents" })).toBeInTheDocument();
});

/** The tree alone, its agents held in state so a test can swap one as a status frame does. */
let setTreeAgents: (f: (a: AgentSummary[]) => AgentSummary[]) => void = () => {};
function TreeHarness({ initial }: { initial: AgentSummary[] }) {
  const [agents, setAgents] = useState(initial);
  setTreeAgents = setAgents;
  return <AgentTree agents={agents} />;
}
function renderTree(initial: AgentSummary[]) {
  const root = createRootRoute({ component: () => <TreeHarness initial={initial} /> });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return {
    router,
    update: (f: (a: AgentSummary[]) => AgentSummary[]) => act(() => setTreeAgents(f)),
  };
}

/** 214 agents in a 14-level chain with wide fan-out below it. */
const many = () =>
  Array.from({ length: 214 }, (_, i) =>
    agentSummary({
      handle: `a${i}`,
      displayName: `Agent ${i}`,
      reportsTo:
        i === 0
          ? { kind: "human", ref: refFor("or"), handle: "or" }
          : (() => {
              const parent = i < 14 ? `a${i - 1}` : `a${i % 14}`;
              return { kind: "agent" as const, ref: refFor(parent), handle: parent };
            })(),
    }),
  );

test("214 rows mount no menu at rest: one shared menu opens on demand", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({})),
  );
  renderTree(many());
  const list = await screen.findByRole("list", { name: "Agents" });
  expect(within(list).getAllByRole("button", { name: /^Actions for / })).toHaveLength(214);
  expect(document.querySelectorAll("[data-menu-stand-in]")).toHaveLength(0);
  expect(document.querySelectorAll('[aria-haspopup="menu"][data-state]')).toHaveLength(0);
  await userEvent.click(within(list).getByRole("button", { name: "Actions for Agent 7" }));
  expect(await screen.findByRole("menu")).toBeInTheDocument();
  expect(document.querySelectorAll("[data-menu-stand-in]")).toHaveLength(1);
});

test("one agent's status frame re-renders exactly one row", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({})),
  );
  const { update } = renderTree(many());
  await screen.findByRole("list", { name: "Agents" });
  chipRenders.length = 0;
  update((list) => list.map((a) => (a.handle === "a20" ? { ...a, status: "working" } : a)));
  await waitFor(() => expect(chipRenders).toEqual([refFor("a20")]));
});

test.each([
  ["New task", "New task"],
  ["Edit", "Edit agent"],
])(
  "%s from a row's menu returns focus to that row's ⋯ when its sheet closes",
  async (item, title) => {
    mockWorld({ agents: [agentSummary()] });
    renderApp("/agents", alice);
    const main = await screen.findByRole("main");
    const more = await within(main).findByRole("button", { name: "Actions for Dev agent" });
    const u = userEvent.setup();
    await u.click(more);
    await u.click(await screen.findByRole("menuitem", { name: item }));
    const sheet = await screen.findByRole("dialog", { name: title });
    expect(sheet).toBeInTheDocument();
    await u.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: title })).toBeNull());
    await waitFor(() => expect(more).toHaveFocus());
  },
);

test("touch: a 500ms press on an Agents row opens its menu at the point and doesn't navigate", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({})),
  );
  const { router } = renderTree(many());
  const list = await screen.findByRole("list", { name: "Agents" });
  const link = list.querySelector(`[data-agent-link="${refFor("a7")}"]`) as HTMLElement;
  expect(link).toHaveAttribute("data-longpress-region");
  chipRenders.length = 0;
  longPress(link, { x: 30, y: 70 });
  expect(await screen.findByRole("menu", { name: "Agent 7" })).toBeInTheDocument();
  const point = document.querySelector<HTMLElement>("[data-menu-stand-in].size-0");
  expect(point?.style.left).toBe("30px");
  // Only the pressed row re-renders (its menu-open flag), never the others.
  expect(chipRenders).toEqual([refFor("a7")]);
  expect(router.state.location.pathname).toBe("/");
});

test("a mouse press on an Agents row opens nothing", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({})),
  );
  renderTree(many());
  const list = await screen.findByRole("list", { name: "Agents" });
  const link = list.querySelector(`[data-agent-link="${refFor("a7")}"]`) as HTMLElement;
  longPress(link, { pointerType: "mouse", hold: 700, release: false });
  expect(link).not.toHaveAttribute("data-pressed");
  expect(screen.queryByRole("menu")).toBeNull();
});
