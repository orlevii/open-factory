import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import sidebarSource from "@/components/ui/sidebar.tsx?raw";
import { installInputModality } from "@/lib/input-modality";
import type { WsOptions, WsStatus } from "@/lib/ws";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { agentSummary } from "@/test/session-fixtures";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
const ws = vi.hoisted(() => ({
  onStatus: undefined as ((s: WsStatus) => void) | undefined,
  onMessage: undefined as ((m: unknown) => void) | undefined,
}));
vi.mock("@/lib/ws", () => ({
  connectWs: (opts: WsOptions) => {
    ws.onStatus = opts.onStatus;
    ws.onMessage = opts.onMessage as ((m: unknown) => void) | undefined;
    return { close() {}, status: () => "connecting", send: () => true };
  },
}));

beforeEach(() => {
  ws.onStatus = undefined;
  ws.onMessage = undefined;
});
afterEach(() => {
  vi.useRealTimers();
});

test("/ opens the Inbox in place of Home: the entry is replaced, and no screen is titled Home", async () => {
  const { router } = renderApp("/", alice);
  expect(await screen.findByRole("heading", { level: 1, name: "Inbox" })).toBeInTheDocument();
  expect(router.state.location.pathname).toBe("/inbox");
  expect(router.history.length).toBe(1);
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  expect(screen.queryByRole("heading", { name: "Home" })).toBeNull();
  expect(document.title).toBe("Inbox · Open Factory");
});

test("the wordmark links to the Inbox", async () => {
  renderApp("/agents", alice);
  const nav = await screen.findByRole("navigation", { name: "Main" });
  expect(nav).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Open Factory" })).toHaveAttribute("href", "/inbox");
});

test("the skip link is the first focusable element and targets main#content", async () => {
  renderApp("/inbox", alice);
  await screen.findByRole("heading", { level: 1, name: "Inbox" });
  await userEvent.tab();
  const skip = screen.getByRole("link", { name: "Skip to content" });
  expect(skip).toHaveFocus();
  expect(skip).toHaveAttribute("href", "#content");
  const main = screen.getByRole("main");
  expect(main).toHaveAttribute("id", "content");
  expect(main).toHaveAttribute("tabindex", "-1");
});

test("activating the skip link focuses main without navigating", async () => {
  const { router } = renderApp("/inbox", alice);
  await screen.findByRole("heading", { level: 1, name: "Inbox" });
  await userEvent.click(screen.getByRole("link", { name: "Skip to content" }));
  expect(screen.getByRole("main")).toHaveFocus();
  expect(router.state.location.pathname).toBe("/inbox");
  expect(router.state.location.hash).toBe("");
});

test("the active section link is marked aria-current=page", async () => {
  renderApp("/agents", alice);
  const nav = await screen.findByRole("navigation", { name: "Main" });
  expect(within(nav).getByRole("link", { name: "Inbox" })).not.toHaveAttribute("aria-current");
  expect(screen.getByRole("link", { name: "Agents" })).toHaveAttribute("aria-current", "page");
});

test("an unknown path shows the not-found state with a way back to the Inbox", async () => {
  renderApp("/nope", alice);
  expect(await screen.findByRole("heading", { name: "Page not found." })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Go to Inbox" })).toHaveAttribute("href", "/inbox");
  expect(screen.getAllByRole("main")).toHaveLength(1);
  expect(document.title).toBe("Page not found · Open Factory");
});

/** Fake timers only (no real-time drift). Returns the fake ms spent until the screen rendered, so the
 *  grace-period assertions are deterministic instead of racing the wall clock. */
async function renderInboxWithFakeTimers() {
  vi.useFakeTimers();
  const t0 = Date.now();
  renderApp("/inbox", alice);
  // vi.waitFor advances the fake clock between checks.
  await vi.waitFor(() => screen.getByRole("heading", { level: 1, name: "Inbox" }));
  return Date.now() - t0;
}
const strip = () => screen.queryByText("Connection lost. Reconnecting…");

test("on first connect the strip appears after 5s, not before", async () => {
  // The grace timer starts when the layout mounts, somewhere inside the first `elapsed` ms.
  const elapsed = await renderInboxWithFakeTimers();
  await act(() => vi.advanceTimersByTimeAsync(5_000 - elapsed - 1));
  expect(strip()).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(elapsed + 1));
  expect(strip()).toBeInTheDocument();
  expect(strip()?.closest('[role="status"]')).toBeInTheDocument();
  act(() => ws.onStatus?.("open"));
  expect(strip()).toBeNull();
});

test("after a drop the strip appears at 3s; reconnect flips don't restart the clock", async () => {
  await renderInboxWithFakeTimers();
  act(() => ws.onStatus?.("open"));
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(strip()).toBeNull();

  act(() => ws.onStatus?.("closed"));
  await act(() => vi.advanceTimersByTimeAsync(1_500));
  act(() => ws.onStatus?.("connecting"));
  await act(() => vi.advanceTimersByTimeAsync(1_499));
  expect(strip()).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(strip()).toBeInTheDocument();

  act(() => ws.onStatus?.("open"));
  expect(strip()).toBeNull();
});

test("a short blip never shows the strip", async () => {
  await renderInboxWithFakeTimers();
  act(() => ws.onStatus?.("open"));
  act(() => ws.onStatus?.("closed"));
  await act(() => vi.advanceTimersByTimeAsync(2_999));
  act(() => ws.onStatus?.("open"));
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(strip()).toBeNull();
});

test("sidebar.tsx no longer animates menu-item or group-label layout", () => {
  expect(sidebarSource).not.toContain("transition-[width,height,padding]");
  expect(sidebarSource).not.toContain("transition-[margin,opacity]");
});

test("mobile nav is a left drawer: click opens, Escape closes, \u2318B opens instantly, a click reopen does not", async () => {
  const original = window.matchMedia;
  const off = installInputModality();
  fakeMatchMedia.install(true);
  try {
    renderApp("/inbox", alice);
    await screen.findByRole("heading", { level: 1, name: "Inbox" });
    const node = () => document.querySelector<HTMLElement>("[data-slot=drawer-content]");
    const content = () => (node()?.getAttribute("data-state") === "open" ? node() : null);
    // jsdom never fires animationend, so Radix Presence would keep the closed node mounted: end it by hand.
    const settleClosed = async () => {
      await vi.waitFor(() => expect(content()).toBeNull());
      const n = node();
      if (n) {
        const e = new Event("animationend", { bubbles: true });
        Object.assign(e, { animationName: getComputedStyle(n).animationName });
        fireEvent(n, e);
      }
      await vi.waitFor(() => expect(node()).toBeNull());
    };
    expect(content()).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
    let c = content();
    expect(c).not.toBeNull();
    expect(c).toHaveAttribute("data-sidebar", "sidebar");
    expect(c).toHaveAttribute("data-mobile", "true");
    expect(c?.style.getPropertyValue("--sidebar-width")).toBe("18rem");
    expect(c).toHaveClass("bg-sidebar");
    expect(within(c as HTMLElement).getByRole("link", { name: "Agents" })).toBeInTheDocument();
    expect(c).not.toHaveAttribute("data-instant");

    await userEvent.keyboard("{Escape}");
    await settleClosed();

    await userEvent.keyboard("{Meta>}b{/Meta}");
    await vi.waitFor(() => expect(content()).not.toBeNull());
    expect(content()).toHaveAttribute("data-instant");
    await userEvent.keyboard("{Meta>}b{/Meta}");
    await settleClosed();

    await userEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
    c = content();
    expect(c).not.toBeNull();
    expect(c).not.toHaveAttribute("data-instant");
  } finally {
    off();
    window.matchMedia = original;
  }
});

test("an agent_status frame pushed through the ws onMessage updates the agent row after one frame", async () => {
  mockApi({
    "GET /api/agents?": () =>
      json({
        agents: [agentSummary({ slug: "dev", displayName: "Dev agent", status: "working" })],
        running: { count: 1, max: 8 },
      }),
  });
  renderApp("/agents", alice);
  const row = await screen.findByRole("link", { name: /Dev agent/ });
  expect(within(row).getByText("Working")).toBeInTheDocument();
  act(() =>
    ws.onMessage?.({
      type: "agent_status",
      agent: "dev",
      status: "idle",
      turnOpen: false,
      restartPending: false,
      restartWaitingOn: 0,
    }),
  );
  // Coalesced: the write lands on the next animation frame, not synchronously.
  expect(within(row).getByText("Working")).toBeInTheDocument();
  expect(await within(row).findByText("Idle")).toBeInTheDocument();
});

const liveAgents = () =>
  mockApi({
    "GET /api/agents?": () =>
      json({
        agents: [
          agentSummary({ slug: "dev", displayName: "Dev agent" }),
          agentSummary({ slug: "qa", displayName: "QA agent", reportsTo: "dev" }),
        ],
        running: { count: 0, max: 8 },
      }),
  });

test("nav order: Inbox, Tasks, Templates, Schedules, Usage, Settings, then the Agents row heading the tree", async () => {
  liveAgents();
  localStorage.clear();
  renderApp("/inbox", alice);
  const nav = await screen.findByRole("navigation", { name: "Main" });
  expect(
    within(nav)
      .getAllByRole("link")
      .map((l) => l.getAttribute("href")),
  ).toEqual(["/inbox", "/tasks", "/templates", "/schedules", "/usage", "/settings"]);
  const agents = screen.getByRole("link", { name: "Agents" });
  expect(nav.compareDocumentPosition(agents) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const tree = await screen.findByRole("tree", { name: "Agents" });
  expect(agents.compareDocumentPosition(tree) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("on a live agent's session the Agents row is not active and the agent row is", async () => {
  liveAgents();
  renderApp("/agents/dev", alice);
  const row = await screen.findByRole("treeitem", { name: /^Dev agent/ });
  expect(row).toHaveAttribute("aria-current", "page");
  // The list lands for the tree and the sidebar's liveness select in separate notifications.
  await vi.waitFor(() =>
    expect(screen.getByRole("link", { name: "Agents" })).not.toHaveAttribute("aria-current"),
  );
});

test("on an ended agent's session the Agents row is active", async () => {
  liveAgents();
  renderApp("/agents/gone", alice);
  await screen.findByRole("tree", { name: "Agents" });
  expect(screen.getByRole("link", { name: "Agents" })).toHaveAttribute("aria-current", "page");
});

test("the Agents row is not active while the agents list is still loading, then follows the session", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  mockApi({
    "GET /api/agents?": async () => {
      await gate;
      return json({
        agents: [agentSummary({ slug: "dev", displayName: "Dev agent" })],
        running: { count: 0, max: 8 },
      });
    },
  });
  renderApp("/agents/gone", alice);
  const agents = await screen.findByRole("link", { name: "Agents" });
  expect(agents).not.toHaveAttribute("aria-current");
  await act(async () => release?.());
  await vi.waitFor(() => expect(agents).toHaveAttribute("aria-current", "page"));
});

test("on a live session the Agents row is active while the tree is collapsed", async () => {
  liveAgents();
  localStorage.setItem("of-tree-collapsed", "true");
  renderApp("/agents/dev", alice);
  const agents = await screen.findByRole("link", { name: "Agents" });
  await vi.waitFor(() => expect(agents).toHaveAttribute("aria-current", "page"));
  expect(screen.queryByRole("tree")).toBeNull();
  // Expanding the tree hands the highlight back to the agent's own row.
  await userEvent.click(screen.getByRole("button", { name: "Expand agents" }));
  expect(await screen.findByRole("treeitem", { name: /^Dev agent/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await vi.waitFor(() => expect(agents).not.toHaveAttribute("aria-current"));
});

test("Agents row: label links /agents, chevron collapses the whole tree (of-tree-collapsed), + opens New agent", async () => {
  liveAgents();
  localStorage.clear();
  renderApp("/inbox", alice);
  expect(await screen.findByRole("link", { name: "Agents" })).toHaveAttribute("href", "/agents");
  expect(screen.getByRole("button", { name: "New agent" })).toHaveAttribute("type", "button");
  await screen.findByRole("tree", { name: "Agents" });
  const chevron = screen.getByRole("button", { name: "Collapse agents" });
  expect(chevron).toHaveAttribute("aria-expanded", "true");
  await userEvent.click(chevron);
  expect(screen.queryByRole("tree")).toBeNull();
  expect(localStorage.getItem("of-tree-collapsed")).toBe("true");
  const open = screen.getByRole("button", { name: "Expand agents" });
  expect(open).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(open);
  expect(await screen.findByRole("tree", { name: "Agents" })).toBeInTheDocument();
});

test("collapsed rail: nav icons, a rule, Agents icon, then only active/unread/badge-worthy avatars; tooltip 'Name · @slug · Status'", async () => {
  mockApi({
    "GET /api/agents?": () =>
      json({
        agents: [
          agentSummary({ slug: "dev", displayName: "Dev agent", status: "working" }),
          agentSummary({ slug: "idle", displayName: "Idle agent", status: "idle" }),
        ],
        running: { count: 1, max: 8 },
      }),
  });
  renderApp("/inbox", alice);
  await screen.findByRole("tree", { name: "Agents" });
  await userEvent.keyboard("{Meta>}b{/Meta}");
  const rail = await screen.findByRole("navigation", { name: "Agents" });
  expect(
    within(rail)
      .getAllByRole("link")
      .map((l) => l.getAttribute("href")),
  ).toEqual(["/agents/dev"]);
  const nav = screen.getByRole("navigation", { name: "Main" });
  const agentsIcon = screen.getByRole("link", { name: "Agents" });
  expect(agentsIcon).toHaveAttribute("href", "/agents");
  const rule = screen.getByRole("separator");
  expect(nav.compareDocumentPosition(rule) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(rule.compareDocumentPosition(agentsIcon) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(agentsIcon.compareDocumentPosition(rail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // The row's chevron and + do not fit the rail.
  expect(screen.queryByRole("button", { name: /agents$/ })).toBeNull();
  const avatar = within(rail).getByRole("link").querySelector("span.relative");
  await userEvent.hover(avatar as Element);
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Dev agent · @dev · Working");
});

test("mobile drawer: tapping an agent closes the drawer", async () => {
  liveAgents();
  const original = window.matchMedia;
  fakeMatchMedia.install(true);
  try {
    renderApp("/inbox", alice);
    await screen.findByRole("heading", { level: 1, name: "Inbox" });
    await userEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
    const node = () => document.querySelector<HTMLElement>("[data-slot=drawer-content]");
    await userEvent.click(await screen.findByRole("treeitem", { name: /^Dev agent/ }));
    await vi.waitFor(() => expect(node()?.getAttribute("data-state")).not.toBe("open"));
  } finally {
    window.matchMedia = original;
  }
});

test("large text on a short phone: the tree keeps 12rem and the sidebar content scrolls, so an agent row stays reachable", async () => {
  // jsdom has no layout: the classes are the contract. At 200% text on 390x844 the nav filled the drawer and
  // the tree shrank to a sliver under its sticky Agents row, so a press on an agent row landed on that row.
  liveAgents();
  const original = window.matchMedia;
  fakeMatchMedia.install(true);
  try {
    renderApp("/inbox", alice);
    await screen.findByRole("heading", { level: 1, name: "Inbox" });
    await userEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
    const tree = await screen.findByRole("tree", { name: "Agents" });
    const group = tree.closest<HTMLElement>("[data-sidebar=group]");
    const content = tree.closest<HTMLElement>("[data-sidebar=content]");
    expect(group).toHaveClass("min-h-48", "overflow-y-auto");
    expect(group).not.toHaveClass("min-h-0");
    expect(content).toHaveClass("overflow-y-auto");
  } finally {
    window.matchMedia = original;
  }
});

test("footer name and handle get a tooltip when truncated", async () => {
  liveAgents();
  renderApp("/inbox", alice);
  const handle = await screen.findByText("@alice", { selector: "span.truncate" });
  vi.spyOn(handle, "scrollWidth", "get").mockReturnValue(200);
  vi.spyOn(handle, "clientWidth", "get").mockReturnValue(100);
  await userEvent.hover(handle);
  expect(await screen.findByRole("tooltip")).toHaveTextContent("@alice");
});
