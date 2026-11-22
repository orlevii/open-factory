import type { LiveEvent, LiveEventBody } from "@open-factory/harness";
import { liveKey } from "@open-factory/shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CAP_BYTES, capPayload } from "./cap.ts";
import { LIVE_INTERVAL_MS, type LiveFrameBody, LiveState } from "./live-state.ts";

const at = (line: number, e: LiveEventBody): LiveEvent => ({ ...e, line }) as LiveEvent;
const start = (line: number, messageId: string, index: number) =>
  at(line, { type: "text_start", messageId, index });
const delta = (line: number, messageId: string, index: number, text: string) =>
  at(line, { type: "text_delta", messageId, index, text });
const progress = (line: number, toolUseId: string, toolUses = 1) =>
  at(line, {
    type: "subagent_progress",
    toolUseId,
    description: "Find files",
    subagentType: "Explore",
    toolUses,
    tokens: 100,
    durationMs: 1000,
  });

let published: LiveFrameBody[];
let s: LiveState;
beforeEach(() => {
  vi.useFakeTimers();
  published = [];
  s = new LiveState((b) => published.push(b));
});
afterEach(() => {
  vi.useRealTimers();
});
/** Every frame published so far, after the coalescing window has passed. */
const out = () => {
  vi.advanceTimersByTime(LIVE_INTERVAL_MS);
  return published.splice(0);
};

describe("text blocks", () => {
  test("deltas accumulate; offsets are UTF-16 lengths of what was already sent", () => {
    s.apply(start(1, "m", 1));
    s.apply(delta(2, "m", 1, "héllo 😀"));
    expect(published).toEqual([
      { texts: [{ messageId: "m", index: 1, offset: 0, append: "héllo 😀" }] },
    ]);
    published.length = 0;
    s.apply(delta(3, "m", 1, " wörld"));
    s.apply(delta(4, "m", 1, "!"));
    expect(out()).toEqual([
      { texts: [{ messageId: "m", index: 1, offset: "héllo 😀".length, append: " wörld!" }] },
    ]);
    expect("héllo 😀".length).toBe(8); // the emoji is two code units
    expect(out()).toEqual([]);
    expect(s.snapshot().texts).toEqual([
      { messageId: "m", index: 1, offset: 0, append: "héllo 😀 wörld!" },
    ]);
  });

  test("retire removes the block and later deltas for its key are dropped", () => {
    s.apply(start(1, "m", 1));
    s.apply(delta(2, "m", 1, "abc"));
    s.retire(liveKey("m", 1));
    expect(s.snapshot().texts).toEqual([]);
    published.length = 0;
    s.apply(delta(3, "m", 1, "late"));
    expect(s.snapshot().texts).toEqual([]);
    expect(out()).toEqual([]);
  });

  test("two blocks are live when the next starts before the previous one retires", () => {
    s.apply(start(1, "m", 1));
    s.apply(delta(2, "m", 1, "first"));
    s.apply(start(3, "m", 2));
    s.apply(delta(4, "m", 2, "second"));
    out();
    expect(s.snapshot().texts?.map((t) => [t.index, t.append])).toEqual([
      [1, "first"],
      [2, "second"],
    ]);
    s.retire(liveKey("m", 1));
    expect(s.snapshot().texts?.map((t) => t.index)).toEqual([2]);
  });

  test("a 70 KB block stops at 64 KiB, capped, equal to the persisted (capPayload) text", () => {
    const full = `${"a".repeat(CAP_BYTES - 1)}é${"b".repeat(70 * 1024 - CAP_BYTES)}`;
    s.apply(start(1, "m", 0));
    let appended = "";
    for (let i = 0; i < full.length; i += 1000) {
      s.apply(delta(2 + i, "m", 0, full.slice(i, i + 1000)));
      for (const p of out())
        for (const t of p.texts ?? []) {
          expect(t.offset).toBe(appended.length);
          appended += t.append;
        }
    }
    const persisted = capPayload({ type: "assistant_text", text: full }).payload.text;
    expect(appended).toBe(persisted);
    const [snap] = s.snapshot().texts ?? [];
    expect(snap).toEqual({ messageId: "m", index: 0, offset: 0, append: persisted, capped: true });
    expect(Buffer.byteLength(snap?.append ?? "", "utf8")).toBeLessThanOrEqual(CAP_BYTES);
  });

  test("the patch that reaches the cap says capped", () => {
    s.apply(start(1, "m", 0));
    s.apply(delta(2, "m", 0, "x".repeat(CAP_BYTES + 10)));
    expect(out()[0]?.texts?.[0]).toMatchObject({ offset: 0, capped: true });
  });
});

describe("ends", () => {
  test("turn_end at line N clears only what started before N and publishes a reset", () => {
    s.apply(start(1, "m1", 0));
    s.apply(delta(2, "m1", 0, "old"));
    s.apply(start(10, "m2", 0)); // a self-started turn the live loop already began
    s.apply(delta(11, "m2", 0, "new"));
    out();
    s.endBefore(5, { subagents: false });
    expect(published).toEqual([
      {
        reset: true,
        texts: [{ messageId: "m2", index: 0, offset: 0, append: "new" }],
        toolInput: null,
        thinking: null,
        subagents: [],
        retire: ["m1:0"],
      },
    ]);
    // a lagging delta from before the end can't recreate the cleared block
    s.apply(delta(3, "m1", 0, "late"));
    expect(s.snapshot().texts?.map((t) => t.messageId)).toEqual(["m2"]);
  });

  test("turn_end clears a thinking state that came only from thinking_tokens (no stop)", () => {
    s.apply(at(2, { type: "thinking_start", estimatedTokens: 50 }));
    expect(s.snapshot().thinking).toEqual({ tokens: 50 });
    s.endBefore(3, { subagents: false });
    expect(s.snapshot().thinking).toBeNull();
    expect(published.at(-1)).toMatchObject({ reset: true, thinking: null });
  });

  test("turn_end keeps subagents; exited clears them too", () => {
    s.apply(progress(1, "toolu_a"));
    s.endBefore(2, { subagents: false });
    expect(s.snapshot().subagents?.map((p) => p.toolUseId)).toEqual(["toolu_a"]);
    s.endBefore(3, { subagents: true });
    expect(s.snapshot().subagents).toEqual([]);
    expect(published.at(-1)).toMatchObject({ reset: true, subagents: [] });
  });

  test("an end with nothing live publishes nothing", () => {
    s.endBefore(5, { subagents: true });
    expect(published).toEqual([]);
  });

  test("a new process starts from empty state and line 0", () => {
    s.apply(start(1, "m", 0));
    s.endBefore(100, { subagents: true });
    s.newProcess();
    s.apply(start(1, "n", 0));
    s.apply(delta(2, "n", 0, "hi"));
    expect(s.snapshot().texts?.map((t) => t.append)).toEqual(["hi"]);
  });
});

describe("tool input, thinking and subagents", () => {
  test("tool input follows bytes and target; retiring its key clears it and drops late input", () => {
    s.apply(
      at(1, { type: "tool_start", messageId: "m", index: 2, toolUseId: "t1", name: "Write" }),
    );
    s.apply(at(2, { type: "tool_input", messageId: "m", index: 2, bytes: 40, target: "/a.md" }));
    expect(out()).toEqual([
      { toolInput: { toolUseId: "t1", name: "Write", bytes: 40, target: "/a.md" } },
    ]);
    s.retire(liveKey("m", 2));
    s.apply(at(3, { type: "tool_input", messageId: "m", index: 2, bytes: 90, target: "/a.md" }));
    expect(s.snapshot().toolInput).toBeNull();
  });

  test("thinking_stop clears thinking with a null patch", () => {
    s.apply(at(1, { type: "thinking_start", estimatedTokens: 12 }));
    expect(out()).toEqual([{ thinking: { tokens: 12 } }]);
    s.apply(at(2, { type: "thinking_stop" }));
    expect(out()).toEqual([{ thinking: null }]);
  });

  test("subagent progress replaces its entry; a finished subagent goes, with a reset", () => {
    s.apply(progress(1, "toolu_a"));
    s.apply(progress(2, "toolu_a", 4));
    s.apply(progress(3, "toolu_b"));
    expect(out()[0]?.subagents?.map((p) => [p.toolUseId, p.toolUses])).toEqual([
      ["toolu_a", 4],
      ["toolu_b", 1],
    ]);
    s.finishSubagent("toolu_a", { agent: true });
    expect(published.at(-1)).toMatchObject({ reset: true });
    expect(published.at(-1)?.subagents?.map((p) => p.toolUseId)).toEqual(["toolu_b"]);
    s.apply(progress(4, "toolu_a", 5)); // a lagging progress line can't bring it back
    expect(s.snapshot().subagents?.map((p) => p.toolUseId)).toEqual(["toolu_b"]);
  });
});

describe("coalescing", () => {
  test("a block's first delta publishes at once; the rest coalesce to at most one per 50ms", () => {
    s.apply(start(1, "m", 0));
    s.apply(delta(2, "m", 0, "a"));
    expect(published).toHaveLength(1); // leading edge
    for (let i = 0; i < 10; i++) s.apply(delta(3 + i, "m", 0, "b"));
    vi.advanceTimersByTime(49);
    expect(published).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(published).toHaveLength(2);
    expect(published[1]).toEqual({
      texts: [{ messageId: "m", index: 0, offset: 1, append: "b".repeat(10) }],
    });
    // a new block's first delta right after a flush still waits for the window
    s.apply(start(20, "m", 1));
    s.apply(delta(21, "m", 1, "c"));
    expect(published).toHaveLength(2);
    vi.advanceTimersByTime(50);
    expect(published).toHaveLength(3);
    // quiet: nothing more is published
    vi.advanceTimersByTime(500);
    expect(published).toHaveLength(3);
  });
});

describe("snapshot and patch offsets (review I1)", () => {
  test("a snapshot inside the window holds what was published, so the next patch continues it", () => {
    s.apply(start(1, "m", 0));
    s.apply(delta(2, "m", 0, "so ")); // leading: published
    s.apply(delta(3, "m", 0, "far")); // waits for the window
    published.length = 0;
    const [snap] = s.snapshot().texts ?? [];
    expect(snap).toEqual({ messageId: "m", index: 0, offset: 0, append: "so " });
    const [patch] = out().flatMap((p) => p.texts ?? []);
    expect(patch?.offset).toBe(snap?.append.length);
    expect(`${snap?.append}${patch?.append}`).toBe("so far");
  });

  test("a block not published yet is left out; capped shows once its patch went out", () => {
    s.apply(start(1, "m", 0));
    s.apply(delta(2, "m", 0, "a")); // leading
    s.apply(start(3, "m", 1));
    s.apply(delta(4, "m", 1, "b")); // inside the window
    s.apply(delta(5, "m", 0, "x".repeat(CAP_BYTES))); // caps block 0, not yet sent
    expect(s.snapshot().texts).toEqual([{ messageId: "m", index: 0, offset: 0, append: "a" }]);
    out();
    expect(s.snapshot().texts?.map((t) => [t.index, t.capped])).toEqual([
      [0, true],
      [1, undefined],
    ]);
  });
});

describe("finished subagents (review M1)", () => {
  test("finishing a call that was never a subagent doesn't block that id later", () => {
    s.finishSubagent("toolu_bash", { agent: false });
    s.apply(progress(1, "toolu_bash"));
    expect(s.snapshot().subagents?.map((p) => p.toolUseId)).toEqual(["toolu_bash"]);
  });

  test("an Agent call's finish blocks a late progress line even before any progress arrived", () => {
    s.finishSubagent("toolu_agent", { agent: true });
    s.apply(progress(1, "toolu_agent"));
    expect(s.snapshot().subagents).toEqual([]);
  });
});
