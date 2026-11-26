import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createMapperState, flushMapper, mapLine } from "@open-factory/harness";
import { tagOf } from "@open-factory/shared/tags";
import { testRef } from "../../test/principals.ts";
import type { RuntimeHarness } from "./runtime-harness.ts";

/**
 * Test support only (U3 §11.4): replays a recorded Claude Code stream (the redacted spike traces in
 * `packages/harness/fixtures/u3/`) through the real mapper into a runtime over the fake driver, line by line, so
 * the runtime's live loop, retirement and ends run as they would on a real process. The fixture replay test uses it
 * with fake timers (a `pace` that flushes the 50ms coalescer).
 */

/** One record of a spike trace: `dir` "in" is what the driver wrote to stdin, "out" a stdout line. */
// biome-ignore lint/suspicious/noExplicitAny: trace lines are parsed stream-json
export type TraceLine = { t: number; dir: "in" | "out" | "exit" } & Record<string, any>;

export const TRACES_DIR = fileURLToPath(
  new URL("../../../../../packages/harness/fixtures/u3/", import.meta.url),
);

export function readTrace(name: string): TraceLine[] {
  return readFileSync(`${TRACES_DIR}${name}.jsonl`, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as TraceLine);
}

const isDelta = (l: TraceLine, index: number) =>
  l.dir === "out" &&
  l.type === "stream_event" &&
  l.event?.type === "content_block_delta" &&
  l.event.index === index;

/**
 * The synthetic variant of §11.4: for every streamed block whose complete `assistant` line arrives before its
 * `content_block_stop` (all of them in the spike), the block's last delta is moved to just after that `assistant`
 * line, so it reaches the runtime after the persisted row retired the block.
 */
export function delayLastDeltas(lines: readonly TraceLine[]): TraceLine[] {
  const out = [...lines];
  for (let stop = 0; stop < out.length; stop++) {
    const l = out[stop] as TraceLine;
    if (l.dir !== "out" || l.type !== "stream_event" || l.event?.type !== "content_block_stop")
      continue;
    const index = l.event.index as number;
    let assistant = -1;
    let delta = -1;
    for (let i = stop - 1; i >= 0; i--) {
      const p = out[i] as TraceLine;
      if (p.dir === "out" && p.type === "stream_event" && p.event?.type === "content_block_start")
        if (p.event.index === index) break;
      if (assistant < 0 && p.dir === "out" && p.type === "assistant" && !p.parent_tool_use_id)
        assistant = i;
      if (assistant >= 0 && isDelta(p, index)) {
        delta = i;
        break;
      }
    }
    if (delta < 0) continue;
    const [moved] = out.splice(delta, 1);
    // `assistant` shifted down by one; the delta goes right after it, before the stop
    out.splice(assistant, 0, moved as TraceLine);
  }
  return out;
}

export interface ReplayOptions {
  /** Runs before each trace record (its predecessor's record is `prev`): where time passes. */
  pace?: (line: TraceLine, prev: TraceLine | undefined) => Promise<void>;
  /** Runs after each stdout line was handed to the runtime and its jobs settled. */
  afterLine?: (lineNo: number, line: TraceLine) => Promise<void>;
  /** The human's tag for an interrupt in the trace. */
  by?: string;
}

/**
 * Plays `lines` into `h.rt`: an `in` user message is sent as the human's message (the first one starts the
 * process), an `in` interrupt is the human's Stop, and each `out` line goes through `mapLine` and is emitted on the
 * fake process with its stdout line number, persisted events and live events alike. The `exit` record is not
 * played (the trace's driver closed stdin; the runtime would restart an unexpected exit).
 */
export async function replayTrace(
  h: RuntimeHarness,
  lines: readonly TraceLine[],
  o: ReplayOptions = {},
): Promise<void> {
  const mapper = createMapperState({ resumed: false });
  let lineNo = 0;
  let prev: TraceLine | undefined;
  for (const l of lines) {
    await o.pace?.(l, prev);
    prev = l;
    if (l.dir === "in") {
      if (l.type === "user") await h.send(String(l.message?.content ?? ""));
      else if (l.type === "control_request" && l.request?.subtype === "interrupt")
        await h.rt.interrupt({ by: o.by ?? tagOf(testRef("u1")) });
      await h.rt.settled();
      continue;
    }
    if (l.dir !== "out") continue;
    lineNo += 1;
    const { t: _t, dir: _d, ...json } = l;
    const { events, live } = mapLine(json, mapper, lineNo);
    const proc = h.driver.last;
    if (events.length) proc.emitAt(lineNo, ...events);
    if (live.length) proc.emitLive(...live);
    await h.rt.settled();
    await o.afterLine?.(lineNo, l);
  }
  const held = flushMapper(mapper);
  if (held.length) h.driver.last.emitAt(lineNo, ...held);
  await h.rt.settled();
}
