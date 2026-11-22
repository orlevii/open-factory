import type { HarnessEvent } from "@open-factory/shared";
import { describe, expect, test } from "vitest";
import { readFixture } from "../test-fixtures.ts";
import { BlockIndexer, createStreamState, type LiveEvent, mapStreamEvent } from "./live.ts";
import { createMapperState, flushMapper, mapLine } from "./mapper.ts";

// biome-ignore lint/suspicious/noExplicitAny: fixture lines are parsed JSON
type Line = Record<string, any>;

/** Maps a fixture's stdout lines (spike traces also hold what the driver wrote: `dir: "in"`). */
function mapAll(name: string) {
  const s = createMapperState({ resumed: false });
  const events: HarnessEvent[] = [];
  const live: LiveEvent[] = [];
  const lines: number[] = [];
  let n = 0;
  for (const l of readFixture(name) as Line[]) {
    if (l.dir === "in" || l.dir === "exit") continue;
    const out = mapLine(l, s, ++n);
    for (const e of out.events) {
      events.push(e);
      lines.push(n);
    }
    live.push(...out.live);
  }
  events.push(...flushMapper(s));
  return { events, live, lines };
}
const ofType = <T extends LiveEvent["type"]>(live: LiveEvent[], t: T) =>
  live.filter((l): l is Extract<LiveEvent, { type: T }> => l.type === t);
const texts = (events: HarnessEvent[]) =>
  events.filter((e): e is Extract<HarnessEvent, { type: "assistant_text" }> => {
    return e.type === "assistant_text";
  });
const joinedDeltas = (live: LiveEvent[], messageId?: string, index?: number) =>
  ofType(live, "text_delta")
    .filter((l) => l.messageId === messageId && l.index === index)
    .map((l) => l.text)
    .join("");

describe("stream_event mapping (U3 §11.1)", () => {
  test("joined text deltas equal the persisted block, and keys match", () => {
    const { events, live } = mapAll("u3/partial-text-and-write");
    const all = texts(events);
    expect(all).toHaveLength(2);
    for (const text of all) {
      expect(text.messageId).toMatch(/^msg_/);
      expect(joinedDeltas(live, text.messageId, text.blockIndex)).toBe(text.text);
    }
    // a text_start precedes the deltas of each block
    const first = all[0] as (typeof all)[number];
    const starts = ofType(live, "text_start").filter((l) => l.messageId === first.messageId);
    expect(starts).toEqual([
      expect.objectContaining({ messageId: first.messageId, index: first.blockIndex }),
    ]);
  });

  test("thinking at index 0 shifts text to 1 (blockIndex counts dropped thinking)", () => {
    const { events, live } = mapAll("u3/partial-text-and-write");
    const [text] = texts(events);
    expect(text?.blockIndex).toBe(1);
    const call = events.find((e) => e.type === "tool_call");
    expect(call).toMatchObject({ name: "Write", messageId: text?.messageId, blockIndex: 2 });
    const start = ofType(live, "tool_start")[0];
    expect(start).toMatchObject({
      messageId: text?.messageId,
      index: 2,
      toolUseId: (call as { toolUseId: string }).toolUseId,
      name: "Write",
    });
  });

  test("blockIndex counts blocks across assistant lines of one message (non-streamed trace)", () => {
    const { events } = mapAll("background-subagent-stdin-closed");
    // msg_011ChAkyjxZbKmoQA4wWNQbo: thinking, text, tool_use on three lines
    const keyed = events.filter(
      (e) => (e as { messageId?: string }).messageId === "msg_011ChAkyjxZbKmoQA4wWNQbo",
    );
    expect(keyed.map((e) => [e.type, (e as { blockIndex?: number }).blockIndex])).toEqual([
      ["assistant_text", 1],
      ["tool_call", 2],
    ]);
  });

  test("tool_input target appears once file_path is complete", () => {
    const { live } = mapAll("u3/partial-text-and-write");
    const inputs = ofType(live, "tool_input");
    expect(inputs.length).toBeGreaterThan(3);
    // bytes are cumulative
    for (let i = 1; i < inputs.length; i++)
      expect((inputs[i] as { bytes: number }).bytes).toBeGreaterThanOrEqual(
        (inputs[i - 1] as { bytes: number }).bytes,
      );
    const firstWithTarget = inputs.findIndex((l) => l.target !== undefined);
    expect(firstWithTarget).toBeGreaterThan(0);
    expect(inputs[firstWithTarget]?.target).toBe("/spike/work/notes.txt");
    // never a half path before it, and it stays once known
    for (const l of inputs.slice(0, firstWithTarget)) expect(l.target).toBeUndefined();
    for (const l of inputs.slice(firstWithTarget)) expect(l.target).toBe("/spike/work/notes.txt");
    expect(inputs.at(-1)?.index).toBe(2);
  });

  test("thinking_start/thinking_stop bracket a thinking block", () => {
    const { live } = mapAll("u3/partial-text-and-write");
    const kinds = live.map((l) => l.type);
    const firstStart = kinds.indexOf("thinking_start");
    const firstStop = kinds.indexOf("thinking_stop");
    const firstText = kinds.indexOf("text_start");
    expect(firstStart).toBeGreaterThanOrEqual(0);
    expect(firstStart).toBeLessThan(firstStop);
    expect(firstStop).toBeLessThan(firstText);
    // the latest estimate rides on thinking_start (system/thinking_tokens and thinking_delta)
    const estimates = ofType(live, "thinking_start")
      .slice(0, kinds.slice(0, firstStop).filter((k) => k === "thinking_start").length)
      .map((l) => l.estimatedTokens);
    expect(estimates).toContain(288);
    // message_stop ends any thinking too, and every message streamed stops
    const stops = ofType(live, "message_stop").map((l) => l.messageId);
    expect(stops).toEqual(["msg_011ChGebLNTQqwjNGtYXGYja", "msg_011ChGebcmvpSvA5a4n5goXg"]);
    const stopAt = kinds.indexOf("message_stop");
    expect(kinds[stopAt - 1]).toBe("thinking_stop");
  });

  test("task_progress → subagent_progress", () => {
    const { live } = mapAll("background-subagent-stdin-closed");
    const progress = ofType(live, "subagent_progress");
    expect(progress).toHaveLength(3);
    expect(progress[0]).toEqual({
      type: "subagent_progress",
      toolUseId: "toolu_01PCsnpNhfTd3zTDN5UiWJEG",
      description: "Running Sleep for 25 seconds",
      subagentType: "general-purpose",
      toolUses: 1,
      tokens: 15684,
      durationMs: 995,
      lastTool: "Bash",
      line: 10,
    });
  });

  test("system/thinking_tokens without partial messages → thinking_start", () => {
    const { live } = mapAll("background-subagent-stdin-closed");
    expect(ofType(live, "thinking_start").map((l) => l.estimatedTokens)).toEqual([50, 343]);
  });

  test("task_notification usage → background_task_finished.usage", () => {
    const { events } = mapAll("background-subagent-stdin-closed");
    const done = events.filter((e) => e.type === "background_task_finished");
    expect(done[0]).toMatchObject({
      taskId: "a0342d7d8526e1f94",
      usage: { toolUses: 2, tokens: 24163, durationMs: 8048 },
    });
    // a bash task's notification has no usage
    expect(done[1]).not.toHaveProperty("usage");
  });

  test("async Agent launch → meta async:true (partial-subagent)", () => {
    const { events } = mapAll("u3/partial-subagent");
    const result = events.find((e) => e.type === "tool_result" && !e.parentToolUseId);
    expect(result).toMatchObject({ meta: { tool: "Agent", async: true } });
    expect(events.find((e) => e.type === "background_task_finished")).toMatchObject({
      usage: { toolUses: 0, tokens: 10645, durationMs: 966 },
    });
  });

  test("foreground Agent totals → meta toolUses/tokens/durationMs (partial-thinking-summaries-forward-subagent)", () => {
    const { events } = mapAll("u3/partial-thinking-summaries-forward-subagent");
    const result = events.find((e) => e.type === "tool_result" && !e.parentToolUseId);
    expect(result).toMatchObject({
      meta: { tool: "Agent", toolUses: 0, tokens: 12512, durationMs: 1082 },
    });
  });

  test("interrupt mid-text: one persisted assistant_text equal to the deltas", () => {
    const { events, live } = mapAll("u3/partial-interrupt-mid-text");
    const interrupted = texts(events).filter((t) => t.messageId === "msg_011ChGefbsiqnKFNSNNagpEe");
    expect(interrupted).toHaveLength(1);
    const [t] = interrupted;
    expect(t?.blockIndex).toBe(0);
    expect(joinedDeltas(live, t?.messageId, t?.blockIndex)).toBe(t?.text);
  });

  test("every live event carries its stdout line; subagent stream lines are ignored", () => {
    const { live } = mapAll("u3/partial-text-and-write");
    for (const l of live) expect(l.line).toBeGreaterThan(0);
    const s = createMapperState({ resumed: false });
    const out = mapLine(
      {
        type: "stream_event",
        parent_tool_use_id: "toolu_x",
        api_message_id: "msg_sub",
        event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
      },
      s,
    );
    expect(out).toEqual({ events: [], live: [] });
  });
});

describe("BlockIndexer", () => {
  test("counts blocks seen on earlier lines of the same message; reset forgets", () => {
    const b = new BlockIndexer();
    expect(b.indexFor("m", 0)).toBe(0);
    b.seeLine("m", 1);
    expect(b.indexFor("m", 0)).toBe(1);
    expect(b.indexFor("m", 1)).toBe(2);
    b.seeLine("m", 2);
    expect(b.indexFor("m", 0)).toBe(3);
    expect(b.indexFor("other", 0)).toBe(0);
    b.reset();
    expect(b.indexFor("m", 0)).toBe(0);
  });
});

describe("BlockIndexer keeps subagent messages across a main turn_end", () => {
  const sub = (text: string): Line => ({
    type: "assistant",
    parent_tool_use_id: "toolu_agent",
    message: { id: "msg_sub", model: "m", content: [{ type: "text", text }] },
  });
  const result: Line = { type: "result", subtype: "success", is_error: false, num_turns: 1 };

  test("two text blocks of one subagent message split by a main result get distinct keys", () => {
    const s = createMapperState({ resumed: false });
    const init: Line = { type: "system", subtype: "init", session_id: "s", model: "m" };
    const all = [init, sub("first"), result, sub("second")].map((l, i) => mapLine(l, s, i + 1));
    // the result really ends a main turn in between
    expect(all[2]?.events.some((e) => e.type === "turn_end")).toBe(true);
    const keys = all
      .flatMap((m) => m.events)
      .filter((e) => e.type === "assistant_text")
      .map((e) => [e.messageId, e.blockIndex]);
    expect(keys).toEqual([
      ["msg_sub", 0],
      ["msg_sub", 1],
    ]);
  });

  test("main-session messages still reset at turn_end; a finished subagent is forgotten", () => {
    const b = new BlockIndexer();
    b.seeLine("main", 2);
    b.seeLine("sub", 1, "toolu_agent");
    b.reset();
    expect(b.indexFor("main", 0)).toBe(0);
    expect(b.indexFor("sub", 0)).toBe(1);
    b.forgetParent("toolu_agent");
    expect(b.indexFor("sub", 0)).toBe(0);
  });

  test("the subagent's task_notification forgets its messages", () => {
    const s = createMapperState({ resumed: false });
    mapLine(sub("first"), s, 1);
    mapLine(
      {
        type: "system",
        subtype: "task_notification",
        task_id: "t1",
        tool_use_id: "toolu_agent",
        status: "completed",
        summary: "",
      },
      s,
      2,
    );
    expect(s.blocks.indexFor("msg_sub", 0)).toBe(0);
  });
});

describe("tool_input buffering", () => {
  test("stops holding the partial input once the target is known; bytes keep counting", () => {
    const st = createStreamState();
    const ev = (event: Line): Line => ({ type: "stream_event", api_message_id: "m1", event });
    mapStreamEvent(
      ev({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "t", name: "Write" },
      }),
      st,
    );
    const delta = (partial_json: string) =>
      mapStreamEvent(
        ev({
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json },
        }),
        st,
      );
    delta('{"file_path":"/a.md",');
    const out = delta('"content":"hello"}');
    expect(out).toEqual([
      { type: "tool_input", messageId: "m1", index: 1, bytes: 39, target: "/a.md" },
    ]);
    expect(st.tools.get(1)?.json).toBe("");
  });
});
