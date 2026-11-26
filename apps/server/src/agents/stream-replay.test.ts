import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type LiveFrame, liveKey, type ServerMessage } from "@open-factory/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { LIVE_INTERVAL_MS } from "./live-state.ts";
import { RuntimeHarness } from "./testing/runtime-harness.ts";
import {
  delayLastDeltas,
  readTrace,
  replayTrace,
  type TraceLine,
} from "./testing/stream-replay.ts";

/**
 * U3 §11.4 fixture test, server half (Q35 condition 3): the spike's recorded streams, replayed line by line through
 * the mapper into the runtime (fake process, real LiveState, the 50ms coalescer flushed after every line), produce
 * the frames checked in under `apps/web/src/test/fixtures/stream/`, which the web half folds through the reducer.
 * Regenerate with `UPDATE_STREAM_FIXTURES=1 pnpm vitest run apps/server/src/agents/stream-replay.test.ts`.
 */

const FIXTURES = fileURLToPath(new URL("../../../web/src/test/fixtures/stream/", import.meta.url));
const UPDATE = process.env.UPDATE_STREAM_FIXTURES === "1";

/** What the web half reads: the frames in order, and the subscribe snapshot after each step that published any. */
interface StreamFixture {
  trace: string;
  frames: ServerMessage[];
  /** `after`: how many of `frames` were published when the snapshot was taken (a reload at that point). */
  snapshots: { after: number; reset: LiveFrame }[];
}

const h = new RuntimeHarness();
beforeAll(() => h.setup());
afterAll(() => h.close());
beforeEach(() => {
  // Only timers and the clock: setImmediate (settled()) and the DB driver keep running for real.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-11-21T10:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

/** The runtime's private live state, read for the invariant (never written). */
interface LiveInternals {
  texts: { messageId: string; index: number }[];
  retiredKeys: Set<string>;
}
const internals = () => (h.rt as unknown as { liveState: LiveInternals }).liveState;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Makes frames stable across runs: per-run ids (uuids, the agent's slug, seqs from a shared test DB) become stable
 * placeholders in order of appearance, and timestamps a fixed one.
 */
function normalizer(slug: string) {
  const ids = new Map<string, string>();
  const seqs = new Map<number, number>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (v === slug) return "dev";
      if (ISO.test(v)) return "2026-11-21T10:00:00.000Z";
      return v.replace(UUID, (u) => {
        if (!ids.has(u))
          ids.set(u, `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, "0")}`);
        return ids.get(u) as string;
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return <T extends ServerMessage>(m: T): T => {
    const out = walk(m) as T;
    if (out.type === "session_event") {
      const seq = out.event.seq;
      if (!seqs.has(seq)) seqs.set(seq, seqs.size + 1);
      out.event = { ...out.event, seq: seqs.get(seq) as number };
    }
    return out;
  };
}

interface Replayed {
  fixture: StreamFixture;
  /** Text deltas the live loop received for a key already retired by its persisted row. */
  droppedByKey: number;
}

async function replay(name: string, lines: readonly TraceLine[]): Promise<Replayed> {
  await h.makeRuntime({ holdTimeoutMs: 60_000 });
  const slug = h.rt.agent.slug;
  const norm = normalizer(slug);
  const ours = (m: ServerMessage) =>
    (m.type === "session_event" || m.type === "live") && m.agent === slug;
  const frames: ServerMessage[] = [];
  const snapshots: StreamFixture["snapshots"] = [];
  const off = h.bus.subscribe(h.rt.agent.id, (m) => {
    if (ours(m)) frames.push(norm(m));
  });
  let droppedByKey = 0;
  let messageId: string | undefined;
  try {
    await replayTrace(h, lines, {
      pace: async (l) => {
        // a text delta for a retired key reaches the live loop: it must be dropped, never recreate the block
        if (l.dir === "out" && l.event?.type === "content_block_delta") {
          if (messageId && internals().retiredKeys.has(liveKey(messageId, l.event.index)))
            droppedByKey += 1;
        }
        if (l.dir === "out" && l.event?.type === "message_start") messageId = l.event.message.id;
      },
      afterLine: async () => {
        await vi.advanceTimersByTimeAsync(LIVE_INTERVAL_MS);
        await h.rt.settled();
        const s = internals();
        for (const b of s.texts)
          expect(s.retiredKeys.has(liveKey(b.messageId, b.index))).toBe(false);
        const last = snapshots.at(-1)?.after ?? 0;
        if (frames.length > last)
          snapshots.push({ after: frames.length, reset: norm(h.rt.liveSnapshot()) });
      },
    });
  } finally {
    off();
  }
  return { fixture: { trace: name, frames, snapshots }, droppedByKey };
}

/** One frame (or snapshot) per line, so a regenerated fixture diffs by frame. */
const format = (f: StreamFixture) =>
  `{"trace": ${JSON.stringify(f.trace)},\n"frames": [\n${f.frames.map((m) => JSON.stringify(m)).join(",\n")}\n],\n"snapshots": [\n${f.snapshots.map((x) => JSON.stringify(x)).join(",\n")}\n]}\n`;

function checkFixture(file: string, fixture: StreamFixture) {
  const path = `${FIXTURES}${file}.frames.json`;
  if (UPDATE) {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(path, format(fixture));
    return;
  }
  expect(fixture).toEqual(JSON.parse(readFileSync(path, "utf8")));
}

/** No live patch published after a block's persisted row carries that block (§11.2 retirement). */
function expectNoTextAfterItsRow(frames: ServerMessage[]) {
  const persisted = new Set<string>();
  for (const f of frames) {
    if (f.type === "session_event") {
      const e = f.event.event;
      if (e.type === "assistant_text" && e.messageId !== undefined && e.blockIndex !== undefined)
        persisted.add(liveKey(e.messageId, e.blockIndex));
      if (e.type === "turn_end" || e.type === "exited") persisted.clear();
    } else if (f.type === "live") {
      for (const t of f.texts ?? [])
        expect(persisted.has(liveKey(t.messageId, t.index))).toBe(false);
    }
  }
}

const liveTextKeys = (frames: ServerMessage[]) =>
  new Set(
    frames.flatMap((f) =>
      f.type === "live" ? (f.texts ?? []).map((t) => liveKey(t.messageId, t.index)) : [],
    ),
  );

describe("spike streams replayed into frames (U3 §11.4)", () => {
  for (const name of ["partial-text-and-write", "partial-interrupt-mid-text", "partial-subagent"]) {
    test(name, async () => {
      const { fixture } = await replay(name, readTrace(name));
      expectNoTextAfterItsRow(fixture.frames);
      expect(fixture.frames.some((f) => f.type === "live")).toBe(true);
      checkFixture(name, fixture);
    });
  }

  test("each block's last delta after its assistant line: dropped by its retired key", async () => {
    const lines = delayLastDeltas(readTrace("partial-text-and-write"));
    const { fixture, droppedByKey } = await replay("partial-text-and-write-late-delta", lines);
    // every streamed block of the trace (thinking, two texts, the Write input, the reply) had one late delta
    expect(droppedByKey).toBeGreaterThanOrEqual(2);
    expectNoTextAfterItsRow(fixture.frames);
    // the live blocks never got their last chunk, yet each persisted once
    expect(liveTextKeys(fixture.frames).size).toBe(2);
    checkFixture("partial-text-and-write-late-delta", fixture);
  });
});
