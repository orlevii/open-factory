import type { AgentDetail, AgentSummary, ServerMessage } from "@open-factory/shared";
import type { QueryClient } from "@tanstack/react-query";
import { runningQueryKey } from "@/features/session/api";

/** A hidden tab pauses requestAnimationFrame, so frames flush on a timer there. */
const HIDDEN_FLUSH_MS = 100;

type StatusFrame = Extract<ServerMessage, { type: "agent_status" | "supervisor" }>;
type AgentStatusFrame = Extract<ServerMessage, { type: "agent_status" }>;

let queue: StatusFrame[] = [];
let client: QueryClient | null = null;
let cancelScheduled: (() => void) | null = null;

/** Queue an `agent_status` or `supervisor` frame (anything else is ignored) and schedule one flush:
 *  every frame that arrives before it is folded into the caches in a single pass. */
export function enqueueStatusFrame(qc: QueryClient, m: ServerMessage): void {
  if (m.type !== "agent_status" && m.type !== "supervisor") return;
  if (client && client !== qc) flushStatusFrames();
  client = qc;
  queue.push(m);
  if (cancelScheduled) return;
  // The timer kind is picked when the first frame arrives; `visibilitychange` covers a tab that is
  // hidden or shown in between.
  if (document.hidden) {
    const t = setTimeout(flushStatusFrames, HIDDEN_FLUSH_MS);
    cancelScheduled = () => clearTimeout(t);
  } else {
    const id = requestAnimationFrame(flushStatusFrames);
    cancelScheduled = () => cancelAnimationFrame(id);
  }
}

/** Apply everything queued now (tests, and the tab becoming visible or hidden). */
export function flushStatusFrames(): void {
  cancelScheduled?.();
  cancelScheduled = null;
  const frames = queue;
  const qc = client;
  queue = [];
  if (qc && frames.length > 0) applyStatusFrames(qc, frames);
}

/** Flush at once when visibility changes, and on teardown (an effect re-run for the same client must
 *  not lose the pending frames; on a real unmount the write is harmless). Returns the cleanup. */
export function installStatusFrameFlush(): () => void {
  document.addEventListener("visibilitychange", flushStatusFrames);
  return () => {
    document.removeEventListener("visibilitychange", flushStatusFrames);
    flushStatusFrames();
    client = null;
  };
}

function patchOf(m: AgentStatusFrame) {
  return {
    status: m.status,
    turnOpen: m.turnOpen,
    // A frame without lastError clears it: the server omits the field once the error is gone.
    lastError: m.lastError,
    restartPending: m.restartPending,
    restartWaitingOn: m.restartWaitingOn,
    waitingOn: m.waitingOn ?? { tasks: [], crons: 0 },
    // The live crons and a pending Stop crons (a frame without them means none).
    crons: m.crons ?? [],
    stopCronsPending: m.stopCronsPending ?? false,
    rateLimitedUntil: m.rateLimitedUntil,
    rateLimitExact: m.rateLimitExact,
    runtimeDisabled: m.runtimeDisabled,
    errorKind: m.errorKind,
    image: m.image,
    pulling: m.pulling,
  };
}
type Patch = ReturnType<typeof patchOf>;

const same = (a: unknown, b: unknown) => Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b);
/** The agent with the patch applied; the same object when nothing in it changes. */
function patched<T extends object>(a: T, p: Patch): T {
  const cur = a as Record<string, unknown>;
  for (const k of Object.keys(p) as (keyof Patch)[]) if (!same(cur[k], p[k])) return { ...a, ...p };
  return a;
}

/** Fold a batch of frames into the caches: the last `agent_status` per slug wins, the lists are
 *  written once, `["agents"]` is invalidated at most once, and the newest `supervisor` frame sets the
 *  running count. */
export function applyStatusFrames(qc: QueryClient, frames: ServerMessage[]): void {
  const patches = new Map<string, Patch>();
  let supervisor: Extract<ServerMessage, { type: "supervisor" }> | undefined;
  for (const m of frames) {
    if (m.type === "agent_status") patches.set(m.agent, patchOf(m));
    else if (m.type === "supervisor") supervisor = m;
  }
  if (supervisor)
    qc.setQueryData(runningQueryKey, { count: supervisor.running, max: supervisor.max });
  if (patches.size === 0) return;

  // Lists are keyed by the archived filter (["agents", "exclude"] ...): read them once, before the
  // write, so "entering terminated" is judged against the state before the batch.
  const before = new Map<string, AgentSummary[]>();
  for (const [, l] of qc.getQueriesData<AgentSummary[]>({ queryKey: ["agents"] }))
    for (const a of l ?? [])
      if (patches.has(a.slug)) before.set(a.slug, [...(before.get(a.slug) ?? []), a]);

  let invalidateLists = false;
  for (const [slug, p] of patches) {
    const rows = before.get(slug);
    if (!rows)
      invalidateLists = true; // not cached yet (frame beat the fetch, or a new agent)
    // Entering terminated moves it from the Active list to the Ended one: refetch both, once.
    else if (p.status === "terminated" && rows.some((a) => a.status !== "terminated"))
      invalidateLists = true;
  }
  if (before.size > 0)
    qc.setQueriesData<AgentSummary[]>({ queryKey: ["agents"] }, (l) => {
      if (!l) return l;
      let out: AgentSummary[] | undefined;
      l.forEach((a, i) => {
        const p = patches.get(a.slug);
        const next = p ? patched(a, p) : a;
        if (next === a) return;
        out ??= [...l];
        out[i] = next;
      });
      return out ?? l;
    });

  for (const [slug, p] of patches) {
    if (qc.getQueryData<AgentDetail>(["agent", slug])) {
      qc.setQueryData<AgentDetail>(["agent", slug], (d) =>
        d ? { ...d, agent: patched(d.agent, p) } : d,
      );
    } else {
      void qc.invalidateQueries({ queryKey: ["agent", slug] });
    }
  }
  if (invalidateLists) void qc.invalidateQueries({ queryKey: ["agents"] });
}
