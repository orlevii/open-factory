import type { AgentSummary, ServerMessage } from "@open-factory/shared";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarAgentTree } from "@/features/agents/sidebar-tree";
import { applyStatusFrames } from "@/features/agents/status-frames";
import { createQueryClient } from "@/lib/query-client";
import { agentSummary } from "@/test/session-fixtures";

// Render probes: the tree reads `of-tree-expanded` once per render, a row reads its unread count
// once per render. Both wrap the real hooks.
const probe = vi.hoisted(() => ({ tree: 0, rows: {} as Record<string, number> }));
vi.mock("@/lib/prefs", async (orig) => {
  const real = await orig<typeof import("@/lib/prefs")>();
  return {
    ...real,
    usePref: ((...args: Parameters<typeof real.usePref>) => {
      if (args[0] === "of-tree-expanded") probe.tree++;
      return real.usePref(...args);
    }) as typeof real.usePref,
  };
});
vi.mock("@/features/inbox/api", async (orig) => {
  const real = await orig<typeof import("@/features/inbox/api")>();
  return {
    ...real,
    useUnreadByAgent: (slug: string) => {
      probe.rows[slug] = (probe.rows[slug] ?? 0) + 1;
      return real.useUnreadByAgent(slug);
    },
  };
});

const agents = (over: Partial<Record<string, Partial<AgentSummary>>> = {}) => [
  agentSummary({ slug: "a", displayName: "Alpha", ...over.a }),
  agentSummary({ slug: "b", displayName: "Bravo", reportsTo: "a", ...over.b }),
  agentSummary({ slug: "c", displayName: "Charlie", reportsTo: "b", ...over.c }),
  agentSummary({ slug: "s", displayName: "Sierra", reportsTo: "b", ...over.s }),
];

type Frame = Extract<ServerMessage, { type: "agent_status" }>;
const frame = (agent: string, status: Frame["status"]): Frame => ({
  type: "agent_status",
  agent,
  status,
  turnOpen: status === "working",
  restartPending: false,
  restartWaitingOn: 0,
});

/** The tree's host: holds the active slug so a test can navigate. */
const host = {
  initial: undefined as string | undefined,
  collapsedRail: false,
  set: (_slug: string | undefined) => {},
};
function Host() {
  const [active, setActive] = useState(host.initial);
  host.set = setActive;
  return <SidebarAgentTree activeSlug={active} collapsedRail={host.collapsedRail} />;
}

function setup({
  list = agents() as AgentSummary[] | null,
  byAgent = {} as Record<string, number>,
  activeSlug = undefined as string | undefined,
  collapsedRail = false,
} = {}) {
  const qc: QueryClient = createQueryClient({ queries: { retry: false, staleTime: Infinity } });
  if (list) qc.setQueryData(["agents", "exclude"], list);
  qc.setQueryData(["inbox-unread"], {
    count: Object.values(byAgent).reduce((s, n) => s + n, 0),
    byAgent,
  });
  host.initial = activeSlug;
  host.collapsedRail = collapsedRail;
  const root = createRootRoute({ component: Host });
  const stub = (path: string) =>
    createRoute({ getParentRoute: () => root, path, component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([stub("/agents/$slug"), stub("/agents/new"), stub("/agents")]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <SidebarProvider>
          <RouterProvider router={router} />
        </SidebarProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { qc, router, navigate: (slug: string | undefined) => act(() => host.set(slug)) };
}

/** Apply one frame and let the query cache notify (it batches on a 0ms timer). */
async function push(qc: QueryClient, f: Frame) {
  await act(async () => {
    applyStatusFrames(qc, [f]);
    await new Promise((r) => setTimeout(r, 0));
  });
}

const row = (name: string) => screen.getByRole("treeitem", { name: new RegExp(`^${name}`) });
const stored = () => localStorage.getItem("of-tree-expanded");
const resetProbe = () => {
  probe.tree = 0;
  probe.rows = {};
};

beforeEach(() => {
  localStorage.clear();
  resetProbe();
});
afterEach(() => vi.unstubAllGlobals());

test("A open, B collapsed with a working count named '1 working'", async () => {
  setup({ list: agents({ c: { status: "working" } }) });
  expect(await screen.findByRole("tree")).toBeInTheDocument();
  expect(row("Alpha")).toHaveAttribute("aria-expanded", "true");
  expect(row("Bravo")).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("treeitem", { name: /^Charlie/ })).toBeNull();
  expect(screen.getByText("1 working", { selector: ".sr-only" })).toBeInTheDocument();
  // Flat, not nested: one tree list, levels and positions on each item.
  expect(screen.queryByRole("group")).toBeNull();
  expect(row("Alpha")).toHaveAttribute("aria-level", "1");
  expect(row("Bravo")).toHaveAttribute("aria-level", "2");
  expect(row("Bravo")).toHaveAttribute("aria-setsize", "1");
  expect(row("Bravo")).toHaveAttribute("aria-posinset", "1");
  expect(row("Bravo")).toHaveAttribute("href", "/agents/b");
  expect(screen.getByRole("navigation", { name: "Agents" })).toContainElement(
    screen.getByRole("tree"),
  );
});

test("chevron click toggles without navigating", async () => {
  const { router } = setup();
  await screen.findByRole("tree");
  const chevron = row("Bravo").querySelector("[data-chevron]") as HTMLElement;
  expect(chevron).toHaveAttribute("aria-hidden", "true");
  await userEvent.click(chevron);
  expect(row("Charlie")).toBeInTheDocument();
  expect(row("Bravo")).toHaveAttribute("aria-expanded", "true");
  expect(chevron).toHaveAttribute("data-toggled", "pointer");
  expect(router.state.location.pathname).toBe("/");
  await userEvent.click(chevron);
  expect(screen.queryByRole("treeitem", { name: /^Charlie/ })).toBeNull();
});

test("toggle persists; revealed ancestors don't", async () => {
  setup({ activeSlug: "c" });
  await screen.findByRole("tree");
  expect(row("Charlie")).toHaveAttribute("aria-current", "page");
  expect(row("Bravo")).toHaveAttribute("aria-expanded", "true");
  expect(stored()).toBeNull();
  // Collapsing a revealed ancestor is the user's toggle: it closes and persists.
  await userEvent.click(row("Bravo").querySelector("[data-chevron]") as HTMLElement);
  expect(screen.queryByRole("treeitem", { name: /^Charlie/ })).toBeNull();
  expect(JSON.parse(stored() as string)).toEqual({ b: false });
});

test("a new navigation reveals the active agent again, even back to one whose ancestor was closed", async () => {
  const { navigate } = setup({ activeSlug: "c" });
  await screen.findByRole("tree");
  await userEvent.click(row("Bravo").querySelector("[data-chevron]") as HTMLElement);
  expect(screen.queryByRole("treeitem", { name: /^Charlie/ })).toBeNull();
  await navigate("a");
  await navigate("c");
  expect(row("Charlie")).toHaveAttribute("aria-current", "page");
  expect(row("Bravo")).toHaveAttribute("aria-expanded", "true");
});

test("a user toggle writes only that slug, pruned to live agents", async () => {
  localStorage.setItem("of-tree-expanded", JSON.stringify({ gone: true }));
  setup();
  await screen.findByRole("tree");
  await userEvent.click(row("Bravo").querySelector("[data-chevron]") as HTMLElement);
  expect(JSON.parse(stored() as string)).toEqual({ b: true });
});

test("APG keys: one tab stop, ↓/↑, →/← open/close and move, Home/End, Enter navigates", async () => {
  const { router } = setup();
  await screen.findByRole("tree");
  const tabbable = screen.getAllByRole("treeitem").filter((r) => r.tabIndex === 0);
  expect(tabbable).toHaveLength(1);
  await userEvent.tab();
  expect(row("Alpha")).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}");
  expect(row("Bravo")).toHaveFocus();
  expect(row("Bravo").tabIndex).toBe(0);
  expect(row("Alpha").tabIndex).toBe(-1);
  await userEvent.keyboard("{ArrowRight}");
  expect(row("Bravo")).toHaveAttribute("aria-expanded", "true");
  expect(row("Bravo").querySelector("[data-chevron]")).not.toHaveAttribute("data-toggled");
  expect(row("Bravo")).toHaveFocus();
  await userEvent.keyboard("{ArrowRight}");
  expect(row("Charlie")).toHaveFocus();
  await userEvent.keyboard("{ArrowLeft}");
  expect(row("Bravo")).toHaveFocus();
  await userEvent.keyboard("{End}");
  expect(row("Sierra")).toHaveFocus();
  await userEvent.keyboard("{Home}");
  expect(row("Alpha")).toHaveFocus();
  await userEvent.keyboard("{ArrowUp}");
  expect(row("Alpha")).toHaveFocus();
  await userEvent.keyboard("s");
  expect(row("Sierra")).toHaveFocus();
  await userEvent.keyboard("{ArrowLeft}");
  expect(row("Bravo")).toHaveFocus();
  await userEvent.keyboard("{ArrowLeft}");
  expect(row("Bravo")).toHaveAttribute("aria-expanded", "false");
  await userEvent.keyboard("{ArrowLeft}");
  expect(row("Alpha")).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/agents/a"));
});

test("an agent_status frame re-renders C's row only (B expanded) / B's row only (B collapsed)", async () => {
  localStorage.setItem("of-tree-expanded", JSON.stringify({ b: true }));
  const { qc } = setup();
  await screen.findByRole("tree");
  resetProbe();
  await push(qc, frame("c", "working"));
  expect(probe.rows).toEqual({ c: 1 });
  expect(probe.tree).toBe(0);
});

test("B collapsed: a working child re-renders B's row and the tree once", async () => {
  const { qc } = setup();
  await screen.findByRole("tree");
  resetProbe();
  await push(qc, frame("c", "working"));
  expect(probe.rows).toEqual({ b: 1 });
  expect(probe.tree).toBe(1);
  expect(screen.getByText("1 working", { selector: ".sr-only" })).toBeInTheDocument();
});

test("the tree renders 0 times on a frame that changes no count and no rail membership", async () => {
  const { qc } = setup();
  await screen.findByRole("tree");
  resetProbe();
  // Alpha is an open root: its own status is no one's working count.
  await push(qc, frame("a", "working"));
  expect(probe.tree).toBe(0);
  expect(probe.rows).toEqual({ a: 1 });
});

test("unread count from byAgent, working count hides first when narrow", async () => {
  setup({ list: agents({ c: { status: "working" } }), byAgent: { a: 3, b: 120 } });
  await screen.findByRole("tree");
  expect(within(row("Alpha")).getByText("3")).toBeInTheDocument();
  expect(within(row("Bravo")).getByText("99+")).toBeInTheDocument();
  expect(row("Alpha")).toHaveAccessibleName(/3 unread/);
  // The working count gives way only to the name's minimum, never to the row's indent: it shares a
  // wrapping line with the name and drops out of sight when both no longer fit. No container query
  // on the indented row, and the unread count stays outside that line.
  const working = within(row("Bravo")).getByText("1 working", { selector: ".sr-only" })
    .parentElement as HTMLElement;
  expect(`${row("Bravo").className} ${working.className}`).not.toMatch(/@container|@max-/);
  const line = working.closest<HTMLElement>("[data-name-line]");
  expect(line).not.toBeNull();
  // The mechanism: a second line exists and is clipped.
  expect(line?.className).toMatch(/\bflex-wrap\b/);
  expect(line?.className).toMatch(/\boverflow-hidden\b/);
  expect(line).toContainElement(within(row("Bravo")).getByText("Bravo"));
  expect(line).not.toContainElement(within(row("Bravo")).getByText("99+"));
});

test("empty: 'No agents yet.' with New agent link", async () => {
  setup({ list: [] });
  expect(await screen.findByText("No agents yet.")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "New agent" })).toHaveAttribute("href", "/agents/new");
  expect(screen.queryByRole("tree")).toBeNull();
});

test("loading: three skeleton rows", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise(() => {})),
  );
  const { router } = setup({ list: null });
  await vi.waitFor(() => expect(router.state.status).toBe("idle"));
  expect(document.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(3);
  expect(screen.queryByRole("tree")).toBeNull();
});

test("collapsed rail: only the active agent, unread and badge-worthy agents, avatar only", async () => {
  setup({
    list: agents({ a: { status: "working" } }),
    byAgent: { s: 2 },
    activeSlug: "c",
    collapsedRail: true,
  });
  const rail = await screen.findByRole("navigation", { name: "Agents" });
  const links = within(rail).getAllByRole("link");
  expect(links.map((l) => l.getAttribute("href"))).toEqual(["/agents/a", "/agents/c", "/agents/s"]);
  expect(links[1]).toHaveAttribute("aria-current", "page");
  expect(links[0]).toHaveAccessibleName(/Alpha/);
  expect(screen.queryByRole("tree")).toBeNull();
});

test("collapsed rail: the whole link is the tooltip's trigger, mounted only on hover", async () => {
  setup({ list: agents({ a: { status: "working" } }), collapsedRail: true });
  const rail = await screen.findByRole("navigation", { name: "Agents" });
  const link = within(rail).getByRole("link", { name: /Alpha/ });
  expect(link.querySelector("[data-slot=tooltip-trigger]")).toBeNull();
  // A pointer entering the link anywhere, its corner included, not only over the 20px avatar.
  fireEvent.pointerEnter(link);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(/Alpha · @a · /);
});

test("a click through the rail's open tooltip still follows the link", async () => {
  const { router } = setup({
    list: agents({ a: { status: "working" }, c: { status: "working" } }),
    collapsedRail: true,
  });
  const rail = await screen.findByRole("navigation", { name: "Agents" });
  const link = within(rail).getByRole("link", { name: /Alpha/ });
  fireEvent.pointerEnter(link);
  await screen.findByRole("tooltip");
  const trigger = link.querySelector("[data-slot=tooltip-trigger]") as HTMLElement;
  await userEvent.click(trigger);
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/agents/a"));
});

test("a click on a collapsed manager's working count follows the row's link", async () => {
  const { router } = setup({ list: agents({ c: { status: "working" } }) });
  await screen.findByRole("tree");
  const count = within(row("Bravo")).getByText("1 working", { selector: ".sr-only" })
    .parentElement as HTMLElement;
  fireEvent.pointerEnter(count);
  await screen.findByRole("tooltip");
  const trigger = row("Bravo").querySelector("[data-slot=tooltip-trigger]") as HTMLElement;
  await userEvent.click(trigger);
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/agents/b"));
});
