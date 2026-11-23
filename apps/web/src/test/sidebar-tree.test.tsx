import type { AgentSummary, ServerMessage } from "@open-factory/shared";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarAgentTree } from "@/features/agents/sidebar-tree";
import { applyStatusFrames } from "@/features/agents/status-frames";
import { closeSheet, getSheetState } from "@/features/sheets/sheet-store";
import { createQueryClient } from "@/lib/query-client";
import { endAnimation } from "@/test/end-animation";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { longPress } from "@/test/long-press";
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
    routeTree: root.addChildren([
      stub("/agents/$slug"),
      stub("/agents/$slug/usage"),
      stub("/tasks"),
      stub("/agents/new"),
      stub("/agents"),
    ]),
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
const rowEl = (slug: string) => document.querySelector(`[data-agent-row="${slug}"]`);
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
  expect(row("Bravo")).toHaveAttribute("href", "/agents/b/chat");
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
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/agents/a/chat"));
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

test("empty: 'No agents yet.' with a New agent button that opens the sheet", async () => {
  setup({ list: [] });
  expect(await screen.findByText("No agents yet.")).toBeInTheDocument();
  expect(screen.queryByRole("tree")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "New agent" }));
  expect(getSheetState().parent).toMatchObject({ kind: "new-agent" });
  act(() => closeSheet());
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
  expect(links.map((l) => l.getAttribute("href"))).toEqual([
    "/agents/a/chat",
    "/agents/c/chat",
    "/agents/s/chat",
  ]);
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
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/agents/a/chat"));
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
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/agents/b/chat"));
});

test("each row carries a ⋯ that is out of the tab order; it opens the sidebar menu on its own row", async () => {
  setup({ activeSlug: "a" });
  const user = userEvent.setup();
  await screen.findByRole("tree");
  const more = screen.getByRole("button", { name: "Actions for Alpha" });
  expect(more).toHaveAttribute("tabindex", "-1");
  await user.click(more);
  const menu = await screen.findByRole("menu");
  expect(within(menu).getByRole("menuitem", { name: "Open session" })).toBeInTheDocument();
  expect(within(menu).queryByRole("menuitem", { name: /Agent details|Compact/ })).toBeNull();
  // The open menu hides the page from the accessibility tree: read the row from the DOM.
  expect(rowEl("a")).toHaveAttribute("data-menu-open");
  expect(screen.getAllByRole("menu")).toHaveLength(1);
});

test("one menu for the tree: opening it on another row moves it, rows hold no menu of their own", async () => {
  setup({ activeSlug: "a" });
  const user = userEvent.setup();
  await screen.findByRole("tree");
  await user.click(screen.getByRole("button", { name: "Actions for Alpha" }));
  await screen.findByRole("menu");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await user.click(screen.getByRole("button", { name: "Actions for Bravo" }));
  await screen.findByRole("menu");
  expect(rowEl("b")).toHaveAttribute("data-menu-open");
  expect(rowEl("a")).not.toHaveAttribute("data-menu-open");
});

test("Shift+F10 and the Context Menu key open the menu for the focused row; Esc returns focus to the row", async () => {
  setup({ activeSlug: "a" });
  const user = userEvent.setup();
  await screen.findByRole("tree");
  row("Alpha").focus();
  await user.keyboard("{Shift>}{F10}{/Shift}");
  expect(await screen.findByRole("menu")).toBeInTheDocument();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(row("Alpha")).toHaveFocus();
  await user.keyboard("{ContextMenu}");
  expect(await screen.findByRole("menu")).toBeInTheDocument();
});

test("after a row's menu closes, a frame for that agent doesn't re-render the tree", async () => {
  const { qc } = setup({ activeSlug: "a" });
  const user = userEvent.setup();
  await screen.findByRole("tree");
  await user.click(screen.getByRole("button", { name: "Actions for Alpha" }));
  await screen.findByRole("menu");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  resetProbe();
  // Alpha is an open root: its own status is no one's working count.
  await push(qc, frame("a", "working"));
  expect(probe.tree).toBe(0);
});

test("right-click keeps the browser's own menu", async () => {
  setup({ activeSlug: "a" });
  await screen.findByRole("tree");
  // fireEvent returns false when a handler called preventDefault.
  expect(fireEvent.contextMenu(row("Alpha"))).toBe(true);
  expect(screen.queryByRole("menu")).toBeNull();
});

test("the menu keeps its place over the row while it closes", async () => {
  setup({ activeSlug: "a" });
  const user = userEvent.setup();
  await screen.findByRole("tree");
  const el = rowEl("a") as HTMLElement;
  el.getBoundingClientRect = () => new DOMRect(12, 34, 200, 32);
  await user.click(screen.getByRole("button", { name: "Actions for Alpha" }));
  await screen.findByRole("menu");
  const standIn = () => document.querySelector<HTMLElement>("[data-menu-stand-in]");
  expect(standIn()?.style.top).toBe("34px");
  await user.keyboard("{Escape}");
  // Closed: the stand-in still sits where the row was, so the exit animation doesn't jump.
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(standIn()?.style.top).toBe("34px");
  expect(standIn()?.style.left).toBe("12px");
});

test("the menu closes when its agent leaves the list (terminated by a status frame)", async () => {
  // The refetch the terminate triggers never settles: the frame alone must close it.
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  const { qc } = setup({ activeSlug: "c" });
  const user = userEvent.setup();
  await screen.findByRole("tree");
  await user.click(screen.getByRole("button", { name: "Actions for Charlie" }));
  await screen.findByRole("menu");
  await push(qc, frame("c", "terminated"));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  // Another agent's menu still opens.
  await user.click(screen.getByRole("button", { name: "Actions for Alpha" }));
  expect(await screen.findByRole("menu")).toBeInTheDocument();
});

test("the menu closes when its agent is dropped from the list by a refetch", async () => {
  const { qc } = setup({ activeSlug: "c" });
  const user = userEvent.setup();
  await screen.findByRole("tree");
  await user.click(screen.getByRole("button", { name: "Actions for Charlie" }));
  await screen.findByRole("menu");
  act(() => {
    qc.setQueryData(
      ["agents", "exclude"],
      agents().filter((a) => a.slug !== "c"),
    );
  });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
});

test("an agent dropped while its menu is open and then back doesn't reopen it; focus stays in the tree", async () => {
  const { qc } = setup({ activeSlug: "a" });
  const user = userEvent.setup();
  await screen.findByRole("tree");
  row("Alpha").focus();
  await user.keyboard("{Shift>}{F10}{/Shift}");
  await screen.findByRole("menu");
  act(() => {
    qc.setQueryData(
      ["agents", "exclude"],
      agents({ b: { reportsTo: null } }).filter((a) => a.slug !== "a"),
    );
  });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  // The row is gone: focus falls to the tree's tab stop, not <body>.
  await waitFor(() => expect(document.activeElement).toHaveAttribute("data-agent-row"));
  act(() => {
    qc.setQueryData(["agents", "exclude"], agents());
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(rowEl("a")).not.toHaveAttribute("data-menu-open");
});

test("phone: a row's menu is a drawer titled with the agent's name", async () => {
  const original = window.matchMedia;
  fakeMatchMedia.install(true, { coarse: true });
  try {
    setup({ activeSlug: "a" });
    await screen.findByRole("tree");
    fireEvent.click(screen.getByRole("button", { name: "Actions for Bravo" }));
    const drawer = await screen.findByRole("dialog", { name: "Bravo" });
    expect(within(drawer).getByRole("link", { name: "Open session" })).toBeInTheDocument();
    expect(screen.queryByRole("menu")).toBeNull();
  } finally {
    window.matchMedia = original;
  }
});

test("touch: a 500ms press on a row opens its menu at the press point and doesn't navigate", async () => {
  const { router } = setup({ activeSlug: "a" });
  await screen.findByRole("tree");
  const el = rowEl("b") as HTMLElement;
  expect(el).toHaveAttribute("data-longpress-region");
  resetProbe();
  longPress(el, { x: 40, y: 60 });
  expect(await screen.findByRole("menu", { name: "Bravo" })).toBeInTheDocument();
  // Only the pressed row re-renders (its menu-open flag).
  expect(Object.keys(probe.rows)).toEqual(["b"]);
  expect(rowEl("b")).toHaveAttribute("data-menu-open");
  // The dropdown hangs from the point, not the row's edge.
  const point = document.querySelector<HTMLElement>("[data-menu-stand-in].size-0");
  expect(point?.style.left).toBe("40px");
  expect(point?.style.top).toBe("60px");
  expect(router.state.location.pathname).toBe("/");
});

test("touch: a press shows the pressed fill on the row after 80ms; a mouse press does nothing", async () => {
  const { router } = setup({ activeSlug: "a" });
  await screen.findByRole("tree");
  const el = rowEl("b") as HTMLElement;
  longPress(el, { hold: 80, release: false });
  expect(el).toHaveAttribute("data-pressed");
  fireEvent.pointerCancel(el, { pointerType: "touch", pointerId: 1 });
  expect(el).not.toHaveAttribute("data-pressed");
  longPress(el, { pointerType: "mouse", hold: 700, release: false });
  expect(el).not.toHaveAttribute("data-pressed");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(router.state.location.pathname).toBe("/");
});

test("touch: closing a long-pressed row's dropdown returns focus to that row, not <body>", async () => {
  setup({ activeSlug: "a" });
  await screen.findByRole("tree");
  longPress(rowEl("b") as HTMLElement, { x: 40, y: 60 });
  fireEvent.keyDown(await screen.findByRole("menu", { name: "Bravo" }), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await waitFor(() => expect(rowEl("b")).toHaveFocus());
});

test("phone: closing a long-pressed row's drawer returns focus to that row, not <body>", async () => {
  const original = window.matchMedia;
  fakeMatchMedia.install(true, { coarse: true });
  try {
    setup({ activeSlug: "a" });
    await screen.findByRole("tree");
    longPress(rowEl("b") as HTMLElement, { x: 40, y: 60 });
    const drawer = await screen.findByRole("dialog", { name: "Bravo" });
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    endAnimation(drawer);
    await waitFor(() => expect(document.querySelector("[data-slot=drawer-content]")).toBeNull());
    await waitFor(() => expect(rowEl("b")).toHaveFocus());
  } finally {
    window.matchMedia = original;
  }
});
