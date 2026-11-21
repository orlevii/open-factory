import type { AgentDetail, ServerMessage, SessionEvent } from "@open-factory/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
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
const detail: AgentDetail = { agent: agentSummary(), queue: [], lastSeq: 3 };

vi.mock("./api", () => ({
  agentDetailQueryOptions: (slug: string) => ({
    queryKey: ["agent", slug],
    queryFn: async () => detail,
  }),
  fetchEvents: async () => ({
    events: [ev(1), ev(2), ev(3)],
    hasMore: { before: false, after: false },
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

async function setup(status: WsStatus = "open") {
  let push: (m: ServerMessage) => void = () => {};
  const hub: WsHub = {
    send: () => true,
    listen: (fn) => {
      push = fn;
      return () => {};
    },
    status,
    openCount: 1,
  };
  const qc = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <WsContext.Provider value={hub}>{children}</WsContext.Provider>
    </QueryClientProvider>
  );
  let renders = 0;
  const hook = renderHook(
    () => {
      renders++;
      return useSession("dev");
    },
    { wrapper },
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
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("ten frames delivered across separate tasks commit once, on the next frame", async () => {
  const { hook, push, renders } = await setup();
  const before = renders();
  for (let seq = 4; seq < 14; seq++) {
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
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
  ]);
});

test("frames for another agent schedule nothing", async () => {
  const { push, renders } = await setup();
  const before = renders();
  push(frame(4, "other"));
  expect(vi.getTimerCount()).toBe(0);
  act(() => {
    vi.advanceTimersToNextFrame();
  });
  expect(renders()).toBe(before);
});

test("a hidden tab flushes after 100ms instead of waiting for a frame", async () => {
  const { hook, push } = await setup();
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  push(frame(4));
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
  push(frame(4));
  expect(vi.getTimerCount()).toBe(1);
  hook.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
