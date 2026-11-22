import type { AgentDetail, AnyEvent, ServerMessage, SessionEvent } from "@open-factory/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { Profiler, type ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WsContext, type WsHub } from "@/lib/ws-context";
import { longPress } from "@/test/long-press";
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
const profiled = vi.hoisted(() => async <P extends object>(id: string, C: unknown) => {
  const { Profiler, createElement, memo } = await import("react");
  const wrap = (p: P) =>
    createElement(
      Profiler,
      {
        id,
        onRender: () => count.profiled.set(id, (count.profiled.get(id) ?? 0) + 1),
      },
      createElement(C as never, p as never),
    );
  // A memo component stays one: the wrapper bails out exactly when the real component would.
  const m = C as { $$typeof?: symbol; compare?: (a: P, b: P) => boolean };
  return m.$$typeof === Symbol.for("react.memo") ? memo(wrap, m.compare ?? undefined) : wrap;
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
const warm = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/components/markdown/highlight", async (orig) => ({
  ...(await orig<typeof import("@/components/markdown/highlight")>()),
  warmHighlighter: () => {
    warm.count++;
  },
}));
vi.mock("./stop-crons", async (orig) => {
  const m = await orig<typeof import("./stop-crons")>();
  return { ...m, CronsStopLayer: await profiled("crons", m.CronsStopLayer) };
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
/** Off: the real display passes. On: a stand-in for `mergeFailures` (Task 19) that folds repeated
 *  identical errors into the first, so the announcer can be shown to read the unmerged rows. */
const passes = vi.hoisted(() => ({ mergeErrors: false, rebuild: false }));
vi.mock("./display-passes", async (orig) => {
  const m = await orig<typeof import("./display-passes")>();
  return {
    ...m,
    runDisplayPasses: (raw: Row[]) => {
      // A pass that builds a new object for every row (as a grouping pass does for its groups).
      if (passes.rebuild) return raw.map((r) => ({ ...r }));
      if (!passes.mergeErrors) return m.runDisplayPasses(raw);
      const seen = new Set<string>();
      return raw.filter((r) => {
        if (r.kind !== "error") return true;
        if (seen.has(r.event.message)) return false;
        seen.add(r.event.message);
        return true;
      });
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
/** 200 events: a message, a failed tool, a running tool, then 195 assistant texts. The failed call
 *  keeps the two tools apart (a failure ends a folded run, U3 §9.4), so each is its own row. */
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
  ev(4, { type: "tool_result", toolUseId: "tu-done", content: "a\nb", isError: true }),
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
  passes.mergeErrors = false;
  passes.rebuild = false;
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

/** Every row of `before` is the same object in `after`, except the keys named. */
const keptIdentity = (before: Row[], after: Row[], changed: string[] = []) => {
  const byKey = new Map(after.map((r) => [r.key, r]));
  const lost = before.filter((r) => !changed.includes(r.key) && byKey.get(r.key) !== r);
  expect(lost.map((r) => r.key)).toEqual([]);
};

test("a frame that appends one row keeps every other row's identity through both stabilizations", async () => {
  await setup();
  const raw = seen?.rawRows ?? [];
  const final = seen?.rows ?? [];
  expect(final.length).toBeGreaterThan(0);
  push(sessionEvent(ev(201, { type: "assistant_text", text: "Text 201" })));
  frame();
  expect(seen?.rawRows).toHaveLength(raw.length + 1);
  expect(seen?.rows).toHaveLength(final.length + 1);
  keptIdentity(raw, seen?.rawRows ?? []);
  keptIdentity(final, seen?.rows ?? []);
});

test("rows a display pass rebuilds keep their identity through the second stabilization", async () => {
  passes.rebuild = true;
  await setup();
  const final = seen?.rows ?? [];
  push(sessionEvent(ev(201, { type: "assistant_text", text: "Text 201" })));
  frame();
  keptIdentity(final, seen?.rows ?? []);
  expect(Object.fromEntries(count.rows)).toEqual({ "201": 1 });
});

test("a repeated failure keeps the first occurrence's row: no new key, no remount, no fade", async () => {
  await setup();
  const boom = (seq: number) =>
    sessionEvent(ev(seq, { type: "error", source: "api", code: "x", message: "boom" }, null));
  push(boom(201));
  frame();
  // The tab coming back spends the first failure's fade.
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const wrap = document.querySelector('[data-row="201"]')?.closest("[data-row-wrap]");
  expect(wrap).not.toBeNull();
  expect(wrap).not.toHaveAttribute("data-live");
  const wraps = document.querySelectorAll("[data-row-wrap]").length;
  reset();
  push(boom(202));
  frame();
  expect(document.querySelector('[data-row="202"]')).toBeNull();
  expect(document.querySelector('[data-row="201"]')?.closest("[data-row-wrap]")).toBe(wrap);
  expect(wrap).not.toHaveAttribute("data-live");
  expect(document.querySelectorAll("[data-row-wrap]")).toHaveLength(wraps);
  expect(wrap?.textContent).toContain("2 times");
  expect(Object.fromEntries(count.rows)).toEqual({ "201": 1 });
  expect(count.markdown).toBe(0);
});

test("a tool_result keeps every other row's identity through both stabilizations", async () => {
  await setup();
  const raw = seen?.rawRows ?? [];
  const final = seen?.rows ?? [];
  push(
    sessionEvent(
      ev(201, { type: "tool_result", toolUseId: "tu-run", content: "ok", isError: false }),
    ),
  );
  frame();
  keptIdentity(raw, seen?.rawRows ?? [], ["5"]);
  keptIdentity(final, seen?.rows ?? [], ["5"]);
  expect(seen?.rows.find((r) => r.key === "5")).toBe(seen?.rawRows.find((r) => r.key === "5"));
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

const bashCall = (seq: number) =>
  sessionEvent(
    ev(seq, {
      type: "tool_call",
      toolUseId: `tu${seq}`,
      name: "Bash",
      input: { command: `c${seq}` },
    }),
  );
const bashDone = (seq: number, of: number) =>
  sessionEvent(
    ev(seq, { type: "tool_result", toolUseId: `tu${of}`, content: "ok", isError: false }),
  );

test("a tool row joining a group re-renders only that group, in the same wrapper", async () => {
  await setup();
  push(bashCall(201));
  push(bashDone(202, 201));
  frame();
  const wrap = document.querySelector('[data-row="201"]')?.closest("[data-row-wrap]");
  expect(wrap).not.toBeNull();
  const wraps = document.querySelectorAll("[data-row-wrap]").length;
  reset();
  push(bashCall(203));
  frame();
  expect(Object.fromEntries(count.rows)).toEqual({ "201": 1 });
  expect(count.markdown).toBe(0);
  expect(document.querySelector('[data-row="201"]')?.closest("[data-row-wrap]")).toBe(wrap);
  expect(document.querySelectorAll("[data-row-wrap]")).toHaveLength(wraps);
  expect(document.querySelector('[data-row="201"]')?.textContent).toBe("2 calls so far");
  // A third call: still only the group.
  reset();
  push(bashDone(204, 203));
  push(bashCall(205));
  frame();
  expect(Object.fromEntries(count.rows)).toEqual({ "201": 1 });
  expect(document.querySelector('[data-row="201"]')?.textContent).toBe("3 calls so far");
});

test("the final summary lands with turn_end in one commit", async () => {
  await setup();
  push(bashCall(201));
  push(bashDone(202, 201));
  push(bashCall(203));
  push(bashDone(204, 203));
  frame();
  expect(document.querySelector('[data-row="201"]')?.textContent).toBe("2 calls so far");
  reset();
  push(
    sessionEvent(
      ev(205, {
        type: "usage",
        durationMs: 4000,
        costUsd: 0,
        inputTokens: 1,
        outputTokens: 1,
      } as AnyEvent),
    ),
  );
  push(sessionEvent(ev(206, { type: "turn_end", isError: false } as AnyEvent)));
  frame();
  expect(commits).toBe(1);
  expect(document.querySelector('[data-row="201"]')?.textContent).toBe("Ran 2 commands · 0s");
  // The group, and the fixture's running call, which the turn's end settles as "No result".
  expect(rerendered(["206"])).toEqual({ "5": 1, "201": 1 });
});

test("expanding a group, then a child inside it, re-renders only that group", async () => {
  await setup();
  push(bashCall(201));
  push(bashDone(202, 201));
  push(bashCall(203));
  frame();
  reset();
  const header = document.querySelector<HTMLElement>('button[data-row="201"]');
  act(() => {
    if (header) fireEvent.click(header);
  });
  expect(Object.fromEntries(count.rows)).toEqual({ "201": 1 });
  reset();
  const child = document.querySelector<HTMLElement>('button[data-row="203"]');
  if (!child) throw new Error("no child");
  act(() => {
    fireEvent.click(child);
  });
  expect(child).toHaveAttribute("aria-expanded", "true");
  expect(Object.fromEntries(count.rows)).toEqual({ "201": 1 });
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
const child: Row = { kind: "text", seq: 4, at, text: "nested", key: "4", head: false };
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
  arrivedKey: undefined,
  arrival: undefined,
  onArrivedEnd: noop,
  live: false,
  firstOfSeq: true,
  gap: "",
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
  // The deep-link tint's phase reaches only the item holding it.
  expect(itemPropsEqual(props(), props({ arrivedKey: "4", arrival: "on" }))).toBe(false);
  expect(
    itemPropsEqual(
      props({ arrivedKey: "4", arrival: "on" }),
      props({ arrivedKey: "4", arrival: "fading" }),
    ),
  ).toBe(false);
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
  // The harness sees a SessionView render: the status frame reached every profiled part but the
  // composer, which reads nothing the frame changed (U3 M3).
  for (const id of ["header", "details", "queue", "crons"])
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

test("SessionView: a live frame and an agent_status frame render the composer 0 times; a keystroke renders only the composer", async () => {
  detail = {
    agent: agentSummary({ status: "working", turnOpen: true }),
    queue: [],
    lastSeq: 200,
  };
  await renderSessionView();
  const box = screen.getByRole("combobox", { name: "Message to Dev agent" });
  push(sessionEvent(ev(201, { type: "assistant_text", text: "Text 201" })));
  frame();
  expect(count.rows.get("201")).toBe(1);
  expect(count.profiled.get("composer")).toBeUndefined();
  reset();
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
  expect(count.profiled.get("header")).toBeGreaterThan(0); // the frame did reach SessionView
  expect(count.profiled.get("composer")).toBeUndefined();
  reset();
  act(() => {
    fireEvent.change(box, { target: { value: "a" } });
  });
  expect(box).toHaveValue("a");
  expect(Object.fromEntries(count.profiled)).toEqual({ composer: 1 });
  expect(count.timeline).toBe(0);
  expect(count.rows.size).toBe(0);
});

test("SessionView: a status frame that opens the turn renders the composer once and shows Stop", async () => {
  await renderSessionView();
  expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  push({
    type: "agent_status",
    agent: "dev",
    status: "working",
    turnOpen: true,
    restartPending: false,
    restartWaitingOn: 0,
  });
  frame();
  expect(count.profiled.get("composer")).toBe(1);
  expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
});

test("SessionView: the announcer reads the unmerged rows, so a repeated failure is announced again", async () => {
  passes.mergeErrors = true;
  await renderSessionView();
  const announced = () =>
    screen.getAllByRole("status").find((el) => el.textContent?.startsWith("Error:"))?.textContent;
  push(sessionEvent(ev(201, { type: "error", source: "api", message: "boom" }, null)));
  frame();
  expect(announced()).toBe("Error: boom");
  push(sessionEvent(ev(202, { type: "error", source: "api", message: "boom" }, null)));
  frame();
  // The merged timeline shows one row; the second failure is still announced (D3).
  expect(document.querySelectorAll('[data-row="202"]')).toHaveLength(0);
  expect(announced()).toBe("Error: boom\u200b");
});

const livePatch = (
  messageId: string,
  index: number,
  offset: number,
  append: string,
): ServerMessage => ({
  type: "live",
  agent: "dev",
  texts: [{ messageId, index, offset, append }],
});

test("SessionView: a live frame re-renders only the live row, the activity line and the pill: no other TimelineItem, not the header, details, queue or composer", async () => {
  detail = {
    agent: agentSummary({ status: "working", turnOpen: true }),
    queue: [],
    lastSeq: 200,
  };
  await renderSessionView();
  push(livePatch("m1", 1, 0, "Hel"));
  frame();
  expect(document.querySelector('[data-row="t:m1:1"]')?.textContent).toContain("Hel");
  expect(document.querySelector("[data-activity-line]")).not.toBeNull();
  reset();
  push(livePatch("m1", 1, 3, "lo there"));
  frame();
  expect(document.querySelector('[data-row="t:m1:1"]')?.textContent).toContain("Hello there");
  expect(Object.fromEntries(count.rows)).toEqual({ "t:m1:1": 1 });
  expect(Object.fromEntries(count.profiled)).toEqual({});
});

test("SessionView: the persisted block retires the live one in one commit on the same DOM node, re-rendering only that row", async () => {
  detail = {
    agent: agentSummary({ status: "working", turnOpen: true }),
    queue: [],
    lastSeq: 200,
  };
  await renderSessionView();
  push(livePatch("m1", 1, 0, "Hello wor"));
  frame();
  const node = document.querySelector('[data-row="t:m1:1"]');
  expect(node).not.toBeNull();
  reset();
  push(
    sessionEvent(
      ev(201, { type: "assistant_text", text: "Hello world", messageId: "m1", blockIndex: 1 }),
    ),
  );
  frame();
  expect(document.querySelector('[data-row="t:m1:1"]')).toBe(node);
  expect(node?.textContent).toContain("Hello world");
  expect(node?.closest("[data-row-wrap]")).not.toHaveAttribute("data-live");
  expect(document.querySelectorAll('[data-row="t:m1:1"]')).toHaveLength(1);
  expect(rerendered(["t:m1:1"])).toEqual({});
  expect(Object.fromEntries(count.profiled)).toEqual({});
});

test("SessionView: the activity line reads live frames (text, then tool input), still rendering no other row", async () => {
  detail = {
    agent: agentSummary({ status: "working", turnOpen: true }),
    queue: [],
    lastSeq: 200,
  };
  await renderSessionView();
  const label = () => document.querySelector("[data-activity-label]")?.getAttribute("title");
  // The fixture's running call ends first: an open tool outranks live text (U3 §5.1).
  push(
    sessionEvent(
      ev(201, { type: "tool_result", toolUseId: "tu-run", content: "ok", isError: false }),
    ),
  );
  push(livePatch("m1", 1, 0, "Hel"));
  frame();
  expect(label()).toBe("Writing a reply");
  reset();
  push({
    type: "live",
    agent: "dev",
    toolInput: { toolUseId: "tu9", name: "Write", bytes: 3000, target: "/w/src/app.ts" },
  });
  frame();
  expect(label()).toBe("Writing app.ts");
  expect(Object.fromEntries(count.rows)).toEqual({});
  expect(Object.fromEntries(count.profiled)).toEqual({});
});

const agentCall = (seq: number) =>
  sessionEvent(
    ev(seq, {
      type: "tool_call",
      toolUseId: `ag${seq}`,
      name: "Agent",
      input: { description: `job ${seq}`, prompt: "go" },
    }),
  );
const prog = (id: string, toolUses: number) => ({
  toolUseId: id,
  description: "job",
  subagentType: "general-purpose",
  toolUses,
  tokens: 1000,
  durationMs: 100,
});

test("SessionView: a progress frame re-renders only its subagent card; a text-only frame renders no card", async () => {
  detail = {
    agent: agentSummary({ status: "working", turnOpen: true }),
    queue: [],
    lastSeq: 200,
  };
  await renderSessionView();
  push(agentCall(201));
  push(agentCall(202));
  frame();
  push({ type: "live", agent: "dev", subagents: [prog("ag201", 1), prog("ag202", 1)] });
  frame();
  expect(
    document.querySelector('[data-row="201"]')?.closest("[data-subagent]")?.textContent,
  ).toContain("1 tool call");
  reset();
  push({ type: "live", agent: "dev", subagents: [prog("ag201", 1), prog("ag202", 2)] });
  frame();
  expect(Object.fromEntries(count.rows)).toEqual({ "202": 1 });
  expect(Object.fromEntries(count.profiled)).toEqual({});
  reset();
  push(livePatch("m1", 1, 0, "Hel"));
  frame();
  expect(Object.fromEntries(count.rows)).toEqual({ "t:m1:1": 1 });
});

test("the bare timeline (rows rendering markdown outside a session view) never warms the highlighter", async () => {
  warm.count = 0;
  await setup();
  expect(warm.count).toBe(0);
});

test("SessionView: warms the highlighter once on open, not per frame", async () => {
  warm.count = 0;
  await renderSessionView();
  expect(warm.count).toBe(1);
  push(livePatch("m1", 1, 0, "Hel"));
  frame();
  push(livePatch("m1", 1, 3, "lo"));
  frame();
  expect(warm.count).toBe(1);
});

test("200 rows at rest mount no menu root and read no phone or pointer query (menus mount on intent)", async () => {
  const reads = new Map<string, number>();
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => {
    const real = original(query);
    return new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "matches" || prop === "addEventListener")
          reads.set(query, (reads.get(query) ?? 0) + 1);
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  }) as typeof window.matchMedia;
  try {
    await setup();
    expect(document.querySelectorAll("[data-row-menu]").length).toBeGreaterThan(190);
    expect(document.querySelector('[data-slot="dropdown-menu-trigger"]')).toBeNull();
    expect(document.querySelector('[data-slot="drawer-content"]')).toBeNull();
    const menuQueries = [...reads.keys()].filter(
      (q) => q.includes("48rem") || q.includes("pointer"),
    );
    expect(menuQueries).toEqual([]);
  } finally {
    window.matchMedia = original;
  }
});

test("a long-press on a tool row opens its menu without re-rendering any row", async () => {
  await setup();
  const tool = document.querySelector<HTMLElement>('button[data-row="3"]');
  if (!tool) throw new Error("no tool row");
  longPress(tool);
  expect(await screen.findByRole("menu")).toBeInTheDocument();
  expect(tool).toHaveAttribute("aria-expanded", "false");
  expect(count.rows.size).toBe(0);
  // Only that row's menu mounted: every other ⋯ is still a plain button.
  expect(document.querySelectorAll('[data-slot="dropdown-menu-trigger"]')).toHaveLength(1);
});
