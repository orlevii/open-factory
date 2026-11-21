import type { AgentDetail, AnyEvent, ServerMessage, SessionEvent } from "@open-factory/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { Profiler, type ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WsContext, type WsHub } from "@/lib/ws-context";
import { renderInRouter } from "@/test/render-in-router";
import { agentSummary } from "@/test/session-fixtures";
import type { AgentDetailsPanel } from "./agent-details";
import type { Row } from "./rows";
import { SessionView } from "./session-view";
import { Timeline } from "./timeline";
import { itemPropsEqual, type TimelineItemProps } from "./timeline-item";
import { useSession } from "./use-session";

/** Renders per row key (top-level `TimelineRow` calls only) and per `Markdown` call (spec §9, §13). */
const count = vi.hoisted(() => ({
  rows: new Map<string, number>(),
  markdown: 0,
  builds: 0,
  /** `Timeline` function calls: a SessionView render reaches it. */
  timeline: 0,
  /** Commits under each SessionView-level Profiler (header, Agent details, queue, composer). */
  profiled: new Map<string, number>(),
}));
/** Wraps a component in a counting Profiler (the SessionView render-count harness, U3 M2). */
const profiled = vi.hoisted(() => async <P extends object>(id: string, C: (p: P) => unknown) => {
  const { Profiler, createElement } = await import("react");
  return (p: P) =>
    createElement(
      Profiler,
      {
        id,
        onRender: () => count.profiled.set(id, (count.profiled.get(id) ?? 0) + 1),
      },
      createElement(C as never, p as never),
    );
});
vi.mock("@/components/page-header", async (orig) => {
  const m = await orig<typeof import("@/components/page-header")>();
  return { ...m, PageHeader: await profiled("header", m.PageHeader) };
});
vi.mock("./agent-details", async (orig) => {
  const m = await orig<typeof import("./agent-details")>();
  return { ...m, AgentDetails: await profiled("details", m.AgentDetails) };
});
vi.mock("./queue-items", async (orig) => {
  const m = await orig<typeof import("./queue-items")>();
  return { ...m, QueueItems: await profiled("queue", m.QueueItems) };
});
vi.mock("./composer", async (orig) => {
  const m = await orig<typeof import("./composer")>();
  return { ...m, Composer: await profiled("composer", m.Composer) };
});
vi.mock("./timeline", async (orig) => {
  const m = await orig<typeof import("./timeline")>();
  return {
    ...m,
    Timeline: (p: Parameters<typeof m.Timeline>[0]) => {
      count.timeline++;
      return <m.Timeline {...p} />;
    },
  };
});

vi.mock("./timeline-row", async (orig) => {
  const m = await orig<typeof import("./timeline-row")>();
  return {
    ...m,
    TimelineRow: (p: import("./timeline-row").TimelineRowProps) => {
      count.rows.set(p.row.key, (count.rows.get(p.row.key) ?? 0) + 1);
      return <m.TimelineRow {...p} />;
    },
  };
});
vi.mock("./rows", async (orig) => {
  const m = await orig<typeof import("./rows")>();
  return {
    ...m,
    buildRows: (...a: Parameters<typeof m.buildRows>) => {
      count.builds++;
      return m.buildRows(...a);
    },
  };
});
vi.mock("@/components/markdown/markdown", async (orig) => {
  const m = await orig<typeof import("@/components/markdown/markdown")>();
  return {
    ...m,
    Markdown: (p: Parameters<typeof m.Markdown>[0]) => {
      count.markdown++;
      return <m.Markdown {...p} />;
    },
  };
});

const at = "2026-11-18T00:00:00.000Z";
const ev = (seq: number, event: AnyEvent, turnId: string | null = "t1"): SessionEvent => ({
  seq,
  agentSlug: "dev",
  turnId,
  at,
  event,
});
/** 200 events: a message, a finished tool, a running tool, then 195 assistant texts. */
const initial: SessionEvent[] = [
  ev(1, { type: "turn_started" }),
  ev(
    2,
    {
      type: "message_in",
      messages: [{ id: "m1", from: "@or", kind: "message", urgent: false, body: "Hello" }],
    },
    null,
  ),
  ev(3, { type: "tool_call", toolUseId: "tu-done", name: "Bash", input: { command: "ls" } }),
  ev(4, { type: "tool_result", toolUseId: "tu-done", content: "a\nb", isError: false }),
  ev(5, { type: "tool_call", toolUseId: "tu-run", name: "Bash", input: { command: "make" } }),
  ...Array.from({ length: 195 }, (_, i) =>
    ev(6 + i, { type: "assistant_text", text: `Text ${6 + i}` }),
  ),
];
let detail: AgentDetail = { agent: agentSummary(), queue: [], lastSeq: 200 };

vi.mock("./api", async (orig) => ({
  ...(await orig<typeof import("./api")>()),
  agentDetailQueryOptions: (slug: string) => ({
    queryKey: ["agent", slug],
    queryFn: async () => detail,
  }),
  fetchEvents: async () => ({ events: initial, hasMore: { before: false, after: false } }),
}));

let commits = 0;
let harnessRenders = 0;
let seen: ReturnType<typeof useSession> | undefined;
function Harness() {
  harnessRenders++;
  const s = useSession("dev");
  seen = s;
  return (
    // A "nested-update" is a newly mounted Radix menu settling in a layout effect, not a second frame.
    <Profiler id="timeline" onRender={(_id, phase) => phase !== "nested-update" && commits++}>
      <Timeline
        slug="dev"
        rows={s.rows}
        failedIds={s.failedIds}
        interruptedEnds={s.interruptedEnds}
        liveAfter={s.state.liveAfter}
        handedOff={s.state.handedOff}
        hasMoreBefore={false}
        onLoadEarlier={async () => false}
        earlierError={false}
        footer={null}
      />
    </Profiler>
  );
}

let push: (m: ServerMessage) => void = () => {};
const hub: WsHub = {
  send: () => true,
  listen: (fn) => {
    push = fn;
    return () => {};
  },
  status: "open",
  openCount: 1,
};
async function setup(ui: ReactNode = <Harness />) {
  renderInRouter(
    <QueryClientProvider client={new QueryClient()}>
      <WsContext.Provider value={hub}>{ui}</WsContext.Provider>
    </QueryClientProvider>,
  );
  await screen.findByText("Text 200");
  await waitFor(() => expect(document.querySelector('[data-row="200"]')).not.toBeNull());
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  reset();
}
const reset = () => {
  count.rows.clear();
  count.profiled.clear();
  count.timeline = 0;
  count.markdown = 0;
  count.builds = 0;
  commits = 0;
  harnessRenders = 0;
};
const frame = () =>
  act(() => {
    vi.advanceTimersToNextFrame();
  });
const sessionEvent = (e: SessionEvent): ServerMessage => ({
  type: "session_event",
  agent: "dev",
  event: e,
});
/** Renders of rows that existed before the frame. */
const rerendered = (newKeys: string[] = []) =>
  Object.fromEntries([...count.rows].filter(([k]) => !newKeys.includes(k)));

beforeEach(() => {
  vi.stubGlobal("fetch", () => new Promise(() => {})); // the sender lookups never settle
  detail = { agent: agentSummary(), queue: [], lastSeq: 200 };
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("an agent_status frame renders no row and no markdown", async () => {
  await setup();
  push({
    type: "agent_status",
    agent: "dev",
    status: "working",
    turnOpen: true,
    restartPending: false,
    restartWaitingOn: 0,
  });
  frame();
  expect(count.rows.size).toBe(0);
  expect(count.markdown).toBe(0);
});

test("a queue frame renders no row and no markdown", async () => {
  await setup();
  push({ type: "queue", agent: "dev", items: [] });
  push({
    type: "queue",
    agent: "dev",
    items: [{ id: "q1", kind: "message", body: "next", urgent: false, from: "@or", createdAt: at }],
  });
  frame();
  expect(count.rows.size).toBe(0);
  expect(count.markdown).toBe(0);
});

test("the tab coming back clears every live row's flag without re-rendering any row's content", async () => {
  await setup();
  // 30 live rows over three frames (each batch is 10 or fewer, so all of them are live).
  for (let b = 0; b < 3; b++) {
    for (let i = 0; i < 10; i++) {
      const seq = 201 + b * 10 + i;
      push(sessionEvent(ev(seq, { type: "assistant_text", text: `Text ${seq}` })));
    }
    frame();
  }
  // A live tool with a result, too: tool renderers must not re-render either.
  push(
    sessionEvent(
      ev(231, { type: "tool_call", toolUseId: "tu-live", name: "Bash", input: { command: "ls" } }),
    ),
  );
  push(
    sessionEvent(
      ev(232, { type: "tool_result", toolUseId: "tu-live", content: "x", isError: false }),
    ),
  );
  frame();
  expect(document.querySelectorAll("[data-row-wrap][data-live]")).toHaveLength(31);
  reset();
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(document.querySelectorAll("[data-row-wrap][data-live]")).toHaveLength(0);
  expect(commits).toBe(1);
  expect(count.rows.size).toBe(0);
  expect(count.markdown).toBe(0);
});

test("one appended assistant text renders exactly one new row and one markdown", async () => {
  await setup();
  push(sessionEvent(ev(201, { type: "assistant_text", text: "Text 201" })));
  frame();
  expect(screen.getByText("Text 201")).toBeInTheDocument();
  expect(Object.fromEntries(count.rows)).toEqual({ "201": 1 });
  expect(count.markdown).toBe(1);
});

test("a tool_result for a running tool re-renders exactly that tool row", async () => {
  await setup();
  push(
    sessionEvent(
      ev(201, { type: "tool_result", toolUseId: "tu-run", content: "ok", isError: false }),
    ),
  );
  frame();
  expect(Object.fromEntries(count.rows)).toEqual({ "5": 1 });
  expect(count.markdown).toBe(0);
});

test("a delivery_failed re-renders exactly the affected message row", async () => {
  await setup();
  push(
    sessionEvent(
      ev(201, { type: "delivery_failed", messageIds: ["m1"], reason: "the process stopped" }, null),
    ),
  );
  frame();
  // Its own quiet line is new; of the existing rows only the message re-renders.
  expect(rerendered(["201"])).toEqual({ "2:0": 1 });
  expect(count.rows.get("201")).toBe(1);
});

test("toggling a tool row re-renders only that row", async () => {
  await setup();
  const tool = document.querySelector<HTMLElement>('button[data-row="3"]');
  if (!tool) throw new Error("no tool toggle");
  act(() => {
    fireEvent.click(tool);
  });
  expect(tool).toHaveAttribute("aria-expanded", "true");
  expect(Object.fromEntries(count.rows)).toEqual({ "3": 1 });
});

test("ArrowDown re-renders the old and the new tab row only", async () => {
  await setup();
  const first = document.querySelector<HTMLElement>('[data-row="7"]');
  if (!first) throw new Error("no row");
  act(() => first.focus());
  reset();
  act(() => {
    fireEvent.keyDown(first, { key: "ArrowDown" });
  });
  expect(document.activeElement).toHaveAttribute("data-row", "8");
  expect(Object.fromEntries(count.rows)).toEqual({ "7": 1, "8": 1 });
});

test("ten frames in one task commit once", async () => {
  await setup();
  for (let seq = 201; seq <= 210; seq++)
    push(sessionEvent(ev(seq, { type: "assistant_text", text: `Text ${seq}` })));
  expect(commits).toBe(0);
  frame();
  expect(commits).toBe(1);
  expect(harnessRenders).toBe(1); // a layout-effect setState would add a render here
  expect(count.rows.size).toBe(10);
  expect(count.markdown).toBe(10);
});

test("a row added live gets its controls out of the tab order; the tab row's stay in", async () => {
  await setup();
  push(
    sessionEvent(ev(201, { type: "assistant_text", text: "See [the docs](https://example.com)" })),
  );
  frame();
  await act(async () => {}); // the MutationObserver callback
  expect(screen.getByRole("link", { name: "the docs" })).toHaveAttribute("tabindex", "-1");
  const row = document.querySelector<HTMLElement>('[data-row="201"]');
  act(() => row?.focus());
  expect(screen.getByRole("link", { name: "the docs" })).toHaveAttribute("tabindex", "0");
  act(() => document.querySelector<HTMLElement>('[data-row="200"]')?.focus());
  expect(screen.getByRole("link", { name: "the docs" })).toHaveAttribute("tabindex", "-1");
});

// itemPropsEqual (spec §9.4): a nested child's own state decides whether its parent item re-renders.
const child: Row = { kind: "text", seq: 4, text: "nested", key: "4" };
const parent: Row = {
  kind: "tool",
  seq: 3,
  at,
  call: { type: "tool_call", toolUseId: "tu", name: "Agent", input: {} },
  state: "running",
  children: [child],
  key: "3",
};
const props = (over: Partial<TimelineItemProps> = {}): TimelineItemProps => ({
  row: parent,
  slug: "dev",
  lit: false,
  live: false,
  firstOfSeq: true,
  tabKey: "1",
  expanded: new Set(),
  failedIds: new Set(),
  interruptedEnds: new Set(),
  toggle: noop,
  onRowFocus: noop,
  ...over,
});
const noop = () => {};

test("itemPropsEqual: a nested child entering expanded or becoming the tab row is a change", () => {
  expect(itemPropsEqual(props(), props({ expanded: new Set(["4"]) }))).toBe(false);
  expect(itemPropsEqual(props(), props({ tabKey: "4" }))).toBe(false);
  expect(itemPropsEqual(props({ tabKey: "4" }), props({ tabKey: "1" }))).toBe(false);
  expect(itemPropsEqual(props(), props({ interruptedEnds: new Set([4]) }))).toBe(false);
});

test("itemPropsEqual: unrelated keys and fresh but equal sets are not a change", () => {
  expect(itemPropsEqual(props(), props({ expanded: new Set(["9"]) }))).toBe(true);
  expect(itemPropsEqual(props(), props({ tabKey: "9" }))).toBe(true);
  expect(itemPropsEqual(props(), props({ failedIds: new Set(["x"]) }))).toBe(true);
  expect(itemPropsEqual(props(), props({ row: { ...parent } }))).toBe(false);
  expect(itemPropsEqual(props(), props({ lit: true }))).toBe(false);
});

test("buildRows runs once per events change, not for status or queue frames; open reuses the rendered row", async () => {
  await setup();
  push({
    type: "agent_status",
    agent: "dev",
    status: "working",
    turnOpen: true,
    restartPending: false,
    restartWaitingOn: 0,
  });
  frame();
  // The frame did reach the hook (a render that skipped it would prove nothing).
  expect(harnessRenders).toBeGreaterThan(0);
  expect(count.builds).toBe(0);
  harnessRenders = 0;
  push({ type: "queue", agent: "dev", items: [] });
  frame();
  expect(harnessRenders).toBeGreaterThan(0);
  expect(count.builds).toBe(0);
  const open = seen?.open;
  expect(open?.newestOpenTool?.key).toBe("5");
  expect(open?.newestOpenTool).toBe(seen?.rows.find((r) => r.key === "5"));
  push(sessionEvent(ev(201, { type: "assistant_text", text: "Text 201" })));
  frame();
  expect(count.builds).toBe(1);
  // The text row changed nothing the activity line reads: same open object.
  expect(seen?.open).toBe(open);
});

const noopPanel: AgentDetailsPanel = {
  open: true,
  mode: "inflow",
  toggle: noop,
  setOpen: noop,
  timeline: { current: null },
};
/** The SessionView-level harness: Profilers around the header, Agent details, the queue and the
 *  composer, a call count on `Timeline`, and the row counts (U3 M2; Tasks 44 and 50 reuse it). */
const renderSessionView = () =>
  setup(
    <SidebarProvider>
      <TooltipProvider>
        <SessionView slug="dev" panel={noopPanel} sheetHost={null} />
      </TooltipProvider>
    </SidebarProvider>,
  );

test("SessionView: an Elapsed tick renders only Elapsed", async () => {
  detail = {
    agent: agentSummary({ status: "working", turnOpen: true }),
    queue: [],
    lastSeq: 200,
  };
  await renderSessionView();
  expect(document.querySelector("[data-activity-line]")).not.toBeNull();
  vi.useFakeTimers({
    toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout", "Date"],
  });
  vi.setSystemTime(new Date("2026-11-21T10:00:00.000Z"));
  // The turn's start arrives by frame, so Elapsed's chain runs on the fake clock.
  push({
    type: "agent_status",
    agent: "dev",
    status: "working",
    turnOpen: true,
    restartPending: false,
    restartWaitingOn: 0,
    turnStartedAt: "2026-11-21T10:00:00.000Z",
  });
  frame();
  expect(document.querySelector("[data-activity-line]")?.textContent).toContain("0s");
  // The harness sees a SessionView render: the status frame reached every profiled part.
  for (const id of ["header", "details", "queue", "composer"])
    expect(count.profiled.get(id)).toBeGreaterThan(0);
  expect(count.timeline).toBeGreaterThan(0);
  reset();
  act(() => {
    vi.advanceTimersByTime(3000);
  });
  expect(document.querySelector("[data-activity-line]")?.textContent).toContain("3s");
  expect(Object.fromEntries(count.profiled)).toEqual({});
  expect(count.timeline).toBe(0);
  expect(count.rows.size).toBe(0);
  expect(count.markdown).toBe(0);
});
