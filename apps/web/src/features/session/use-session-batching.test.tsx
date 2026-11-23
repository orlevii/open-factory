import type { AgentDetail, ClientMessage, ServerMessage, SessionEvent } from "@open-factory/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { WsStatus } from "@/lib/ws";
import { WsContext, type WsHub } from "@/lib/ws-context";
import { agentSummary } from "@/test/session-fixtures";
import { useSession } from "./use-session";

const ev = (seq: number): SessionEvent => ({
  seq,
  agentSlug: "dev",
  turnId: null,
  at: "2026-11-18T00:00:00.000Z",
  event: { type: "turn_started" },
});
const detail: AgentDetail = { agent: agentSummary(), queue: [], lastSeq: 4 };

vi.mock("./api", () => ({
  agentDetailQueryOptions: (slug: string) => ({
    queryKey: ["agent", slug],
    queryFn: async () => detail,
  }),
  // The latest page is 2..4; the page before it is 1.
  fetchEvents: async (_slug: string, q: { before?: number } = {}) => ({
    events: q.before ? [ev(1)] : [ev(2), ev(3), ev(4)],
    hasMore: { before: !q.before, after: false },
  }),
  fetchMessage: async () => {
    throw new Error("unused");
  },
}));

const frame = (seq: number, agent = "dev"): ServerMessage => ({
  type: "session_event",
  agent,
  event: ev(seq),
});

async function setup(status: WsStatus = "open", o: { strict?: boolean } = {}) {
  let push: (m: ServerMessage) => void = () => {};
  const sent: ClientMessage[] = [];
  let hub: WsHub = {
    send: (m) => {
      sent.push(m);
      return true;
    },
    listen: (fn) => {
      push = fn;
      return () => {};
    },
    status,
    openCount: 1,
  };
  const qc = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => {
    const tree = (
      <QueryClientProvider client={qc}>
        <WsContext.Provider value={hub}>{children}</WsContext.Provider>
      </QueryClientProvider>
    );
    return o.strict ? <StrictMode>{tree}</StrictMode> : tree;
  };
  let renders = 0;
  const hook = renderHook(
    ({ slug }: { slug: string }) => {
      renders++;
      return useSession(slug);
    },
    { wrapper, initialProps: { slug: "dev" } },
  );
  await waitFor(() => expect(hook.result.current.state.ordered).toHaveLength(3));
  // Fake the frame clock only once the (promise-driven) load has settled.
  vi.useFakeTimers({
    toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout"],
  });
  return {
    hook,
    push: (m: ServerMessage) => push(m),
    renders: () => renders,
    sent,
    /** The socket drops (closed) or comes back (open, a new openCount). */
    setSocket: (next: WsStatus) => {
      hub = { ...hub, status: next, openCount: hub.openCount + (next === "open" ? 1 : 0) };
      hook.rerender({ slug: "dev" });
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("ten frames delivered across separate tasks commit once, on the next frame", async () => {
  const { hook, push, renders } = await setup();
  const before = renders();
  for (let seq = 5; seq < 15; seq++) {
    await Promise.resolve();
    push(frame(seq));
  }
  await Promise.resolve();
  expect(renders()).toBe(before);
  act(() => {
    vi.advanceTimersToNextFrame();
  });
  expect(renders()).toBe(before + 1);
  expect(hook.result.current.state.ordered.map((e) => e.seq)).toEqual([
    2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
  ]);
});

test("frames for another agent schedule nothing", async () => {
  const { push, renders } = await setup();
  const before = renders();
  push(frame(5, "other"));
  expect(vi.getTimerCount()).toBe(0);
  act(() => {
    vi.advanceTimersToNextFrame();
  });
  expect(renders()).toBe(before);
});

test("a hidden tab flushes after 100ms instead of waiting for a frame", async () => {
  const { hook, push } = await setup();
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  push(frame(5));
  act(() => {
    vi.advanceTimersByTime(99);
  });
  expect(hook.result.current.state.ordered).toHaveLength(3);
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(hook.result.current.state.ordered).toHaveLength(4);
});

test("a local queued dispatch flushes pending frames first, keeping their order", async () => {
  const { hook, push } = await setup("closed");
  const item = (id: string) => ({
    id,
    kind: "message" as const,
    body: id,
    urgent: false,
    from: "@or",
    fromKind: "human" as const,
    createdAt: "2026-11-18T00:00:00.000Z",
  });
  push({ type: "queue", agent: "dev", items: [item("q2")] });
  act(() => hook.result.current.onQueued(item("q1")));
  // The frame came first, so the local item lands after it instead of being replaced by it.
  expect(hook.result.current.state.queue.map((q) => q.id)).toEqual(["q2", "q1"]);
  expect(vi.getTimerCount()).toBe(0);
});

test("unmount cancels the pending frame", async () => {
  const { hook, push } = await setup();
  push(frame(5));
  expect(vi.getTimerCount()).toBe(1);
  hook.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test("a frame that changes no row keeps the rows and sets' identity (spec §9.3)", async () => {
  const { hook, push } = await setup();
  const { rows, failedIds, interruptedEnds } = hook.result.current;
  push(frame(5)); // a hidden event: new events, same rows
  act(() => {
    vi.advanceTimersToNextFrame();
  });
  expect(hook.result.current.state.ordered).toHaveLength(4);
  expect(hook.result.current.rows).toBe(rows);
  expect(hook.result.current.failedIds).toBe(failedIds);
  expect(hook.result.current.interruptedEnds).toBe(interruptedEnds);
});

test("a slug change cancels the pending frame and drops the old slug's frames", async () => {
  const { hook, push } = await setup();
  const cancel = vi.spyOn(globalThis, "cancelAnimationFrame");
  const request = vi.spyOn(globalThis, "requestAnimationFrame");
  push(frame(5));
  expect(request).toHaveBeenCalledTimes(1);
  hook.rerender({ slug: "other" });
  expect(cancel).toHaveBeenCalledTimes(1);
  push(frame(6)); // still "dev": the listener now ignores it
  expect(request).toHaveBeenCalledTimes(1);
});

test("loaded flushes pending frames first, so the load's page replaces them", async () => {
  const { hook, push } = await setup();
  push(frame(5));
  await act(() => hook.result.current.retry());
  // Applied after the load, the stale frame would have appended 5 to the fresh page.
  expect(hook.result.current.state.ordered.map((e) => e.seq)).toEqual([2, 3, 4]);
  act(() => {
    vi.advanceTimersToNextFrame();
  });
  expect(hook.result.current.state.ordered.map((e) => e.seq)).toEqual([2, 3, 4]);
});

test("earlier flushes pending frames first", async () => {
  const { hook, push, renders } = await setup();
  push(frame(5));
  await act(() => hook.result.current.loadEarlier());
  expect(hook.result.current.state.ordered.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  expect(vi.getTimerCount()).toBe(0);
  const after = renders();
  act(() => {
    vi.advanceTimersToNextFrame();
  });
  expect(renders()).toBe(after);
});

test("a visibility change commits pending frames at once", async () => {
  const { hook, push } = await setup();
  push(frame(5)); // visible: waits for a frame
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(hook.result.current.state.ordered).toHaveLength(4);
  expect(vi.getTimerCount()).toBe(0);
  push(frame(6)); // hidden: waits 100ms
  hidden.mockReturnValue(false);
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(hook.result.current.state.ordered).toHaveLength(5);
  expect(vi.getTimerCount()).toBe(0);
});

// U3 §11.4: live frames share the frame flush.
const livePatch = (offset: number, append: string): ServerMessage => ({
  type: "live",
  agent: "dev",
  texts: [{ messageId: "m1", index: 1, offset, append }],
});
const snapshots = (sent: ClientMessage[]) => sent.filter((m) => m.type === "live_snapshot");

test("mixed session_event and live frames commit once per frame", async () => {
  const { hook, push, renders } = await setup();
  const before = renders();
  push(livePatch(0, "Hel"));
  push(frame(5));
  push(livePatch(3, "lo"));
  push({ type: "live", agent: "dev", thinking: { tokens: 4 } });
  expect(renders()).toBe(before);
  act(() => {
    vi.advanceTimersToNextFrame();
  });
  expect(renders()).toBe(before + 1);
  const s = hook.result.current.state;
  expect(s.ordered).toHaveLength(4);
  expect(s.live.texts.map((t) => t.text)).toEqual(["Hello"]);
  expect(s.live.thinking).toEqual({ tokens: 4 });
});

test("an offset gap sends exactly one live_snapshot, under StrictMode", async () => {
  const { hook, push, sent } = await setup("open", { strict: true });
  expect(snapshots(sent)).toEqual([]);
  push(livePatch(0, "Hel"));
  act(() => {
    vi.advanceTimersToNextFrame();
  });
  push(livePatch(9, "gap"));
  act(() => {
    vi.advanceTimersToNextFrame();
  });
  expect(snapshots(sent)).toEqual([{ type: "live_snapshot", agent: "dev" }]);
  // Another gap before the snapshot arrives doesn't ask again.
  push(livePatch(12, "more"));
  act(() => {
    vi.advanceTimersToNextFrame();
  });
  expect(snapshots(sent)).toHaveLength(1);
  push({
    type: "live",
    agent: "dev",
    reset: true,
    texts: [{ messageId: "m1", index: 1, offset: 0, append: "Hello gapmore" }],
  });
  act(() => {
    vi.advanceTimersToNextFrame();
  });
  expect(hook.result.current.state.live.texts.map((t) => t.text)).toEqual(["Hello gapmore"]);
  expect(snapshots(sent)).toHaveLength(1);
});

test("live state survives a socket drop; the resubscribe's reset replaces it in place", async () => {
  const { hook, push, sent, setSocket } = await setup();
  push(livePatch(0, "Hello"));
  act(() => {
    vi.advanceTimersToNextFrame();
  });
  const live = hook.result.current.state.live;
  act(() => setSocket("closed"));
  expect(hook.result.current.state.live).toBe(live);
  act(() => setSocket("open"));
  expect(hook.result.current.state.live).toBe(live);
  expect(sent.filter((m) => m.type === "subscribe")).toHaveLength(2);
  push({
    type: "live",
    agent: "dev",
    reset: true,
    texts: [{ messageId: "m1", index: 1, offset: 0, append: "Hello world" }],
  });
  act(() => {
    vi.advanceTimersToNextFrame();
  });
  const texts = hook.result.current.state.live.texts;
  expect(texts.map((t) => [t.text, t.fromReset])).toEqual([["Hello world", false]]);
});

test("a reset marks the view caught up: replayed rows before it don't fade", async () => {
  const { hook, push } = await setup();
  push(frame(5));
  push(frame(6));
  push({ type: "live", agent: "dev", reset: true });
  act(() => {
    vi.advanceTimersToNextFrame();
  });
  expect(hook.result.current.state.liveAfter).toBe(6);
});

test("agent_commands_changed is skipped: no flush, no render", async () => {
  const { push, renders } = await setup();
  const before = renders();
  push({ type: "agent_commands_changed", agent: "dev" });
  act(() => {
    vi.advanceTimersToNextFrame();
  });
  expect(renders()).toBe(before);
});
