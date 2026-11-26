import type { LiveEvent, LiveEventBody } from "@open-factory/harness";
import type { HarnessEvent, LiveFrame, ServerMessage } from "@open-factory/shared";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { testRef } from "../test/principals.ts";
import type { AgentRuntime } from "./agent-runtime.ts";
import { ev, type FakeDriver } from "./testing/fake-driver.ts";
import { RuntimeHarness } from "./testing/runtime-harness.ts";

const h = new RuntimeHarness();
beforeAll(() => h.setup());
afterAll(() => h.close());

let driver: FakeDriver;
let rt: AgentRuntime;
beforeEach(async () => {
  await h.makeRuntime();
  ({ driver, rt } = h);
});

const at = (line: number, e: LiveEventBody): LiveEvent => ({ ...e, line }) as LiveEvent;
const textStart = (line: number, messageId: string, index: number) =>
  at(line, { type: "text_start", messageId, index });
const textDelta = (line: number, messageId: string, index: number, text: string) =>
  at(line, { type: "text_delta", messageId, index, text });
const keyed = (text: string, messageId: string, blockIndex: number): HarnessEvent => ({
  type: "assistant_text",
  text,
  messageId,
  blockIndex,
});
const liveFrames = () => h.frames.filter((f): f is LiveFrame => f.type === "live");
const liveTexts = () => rt.liveSnapshot().texts?.map((t) => t.append);
/** Lets the live loop (microtasks) and the coalescing window run. */
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A started process with an open turn. */
async function openTurn() {
  await h.send("hi");
  driver.last.emitAt(1, ev.session(), ev.turn());
  await rt.settled();
}

test("live text from the process is published and held for a snapshot", async () => {
  await openTurn();
  driver.last.emitLive(textStart(2, "m1", 0), textDelta(3, "m1", 0, "Hello"));
  await tick();
  expect(liveFrames()).toEqual([
    {
      type: "live",
      agent: testRef(rt.agent.id),
      texts: [{ messageId: "m1", index: 0, offset: 0, append: "Hello" }],
    },
  ]);
  expect(rt.liveSnapshot()).toEqual({
    type: "live",
    agent: testRef(rt.agent.id),
    reset: true,
    texts: [{ messageId: "m1", index: 0, offset: 0, append: "Hello" }],
    toolInput: null,
    thinking: null,
    subagents: [],
  });
});

test("the persisted assistant_text retires its block before its session_event is published", async () => {
  await openTurn();
  driver.last.emitLive(textStart(2, "m1", 0), textDelta(3, "m1", 0, "Hello"));
  await tick();
  let seen: string[] | undefined;
  const off = h.bus.subscribe(rt.agent.id, (m: ServerMessage) => {
    if (m.type === "session_event" && m.event.event.type === "assistant_text") seen = liveTexts();
  });
  driver.last.emitAt(4, keyed("Hello", "m1", 0));
  await rt.settled();
  off();
  expect(seen).toEqual([]);
  // a lagging delta of the retired block never brings it back
  driver.last.emitLive(textDelta(3, "m1", 0, " late"));
  await tick();
  expect(liveTexts()).toEqual([]);
});

test("turn_end clears blocks from before its line and publishes a reset after the turn_end row", async () => {
  await openTurn();
  driver.last.emitLive(
    textStart(2, "m1", 0), // interrupted right after text_start: no persisted row
    at(3, { type: "thinking_start", estimatedTokens: 40 }), // thinking_tokens only: no stop
    textStart(9, "m2", 0), // a self-started turn the live loop already began
    textDelta(10, "m2", 0, "next"),
  );
  await tick();
  h.frames.length = 0;
  driver.last.emitAt(5, ev.usage(), ev.end());
  await rt.settled();
  const order = h.frames
    .filter((f) => f.type === "live" || f.type === "session_event")
    .map((f) => (f.type === "live" ? "live" : f.event.event.type));
  expect(order).toEqual(["usage", "turn_end", "live"]);
  expect(liveFrames()[0]).toMatchObject({
    reset: true,
    texts: [{ messageId: "m2", index: 0, offset: 0, append: "next" }],
    thinking: null,
    retire: ["m1:0"],
  });
  expect(rt.liveSnapshot().thinking).toBeNull();
});

test("exited clears everything, subagents included", async () => {
  await openTurn();
  driver.last.emitLive(
    at(2, {
      type: "subagent_progress",
      toolUseId: "toolu_a",
      description: "Look around",
      subagentType: "Explore",
      toolUses: 2,
      tokens: 900,
      durationMs: 1200,
    }),
    textStart(3, "m1", 0),
    textDelta(4, "m1", 0, "partial"),
  );
  await tick(80);
  expect(rt.liveSnapshot().subagents).toHaveLength(1);
  driver.last.exit(1);
  await rt.settled();
  expect(rt.liveSnapshot()).toMatchObject({ texts: [], subagents: [] });
  expect(liveFrames().at(-1)).toMatchObject({ reset: true, texts: [], subagents: [] });
});

test("a subagent's live line goes when its call's result arrives, unless the call is async", async () => {
  await openTurn();
  const progress = (toolUseId: string) =>
    at(2, {
      type: "subagent_progress",
      toolUseId,
      description: "d",
      subagentType: "Explore",
      toolUses: 1,
      tokens: 1,
      durationMs: 1,
    });
  driver.last.emitLive(progress("toolu_sync"), progress("toolu_async"));
  await tick(80);
  driver.last.emitAt(
    3,
    { type: "tool_result", toolUseId: "toolu_sync", content: "done", isError: false },
    {
      type: "tool_result",
      toolUseId: "toolu_async",
      content: "Async agent launched",
      isError: false,
      meta: { tool: "Agent", async: true },
    },
    {
      type: "background_task_started",
      taskId: "task1",
      toolUseId: "toolu_async",
      taskType: "local_agent",
    },
  );
  await rt.settled();
  expect(rt.liveSnapshot().subagents?.map((p) => p.toolUseId)).toEqual(["toolu_async"]);
  driver.last.emitAt(4, ev.taskFinished("task1"));
  await rt.settled();
  expect(rt.liveSnapshot().subagents).toEqual([]);
});

test("a restarted process's live queue is drained", async () => {
  await openTurn();
  driver.last.emitAt(2, ev.usage(), ev.end());
  await rt.settled();
  await rt.requestRestart();
  await rt.settled();
  await h.send("again");
  await rt.settled();
  expect(driver.starts).toHaveLength(2);
  const second = driver.last;
  expect(second.opts.resumeSessionId).toBe("sess-1");
  second.emitAt(1, ev.session(), ev.turn());
  await rt.settled();
  for (let i = 0; i < 50; i++) second.emitLive(textDelta(2 + i, "m9", 0, "x"));
  await tick(80);
  expect(second.live.pending).toBe(0);
  expect(liveTexts()).toEqual(["x".repeat(50)]);
  // the first process's queue ended with it and was drained to the end
  expect(driver.starts[0]?.live.pending).toBe(0);
});

test("the turn_end reset is published right after the turn_end row, before any later await", async () => {
  await openTurn();
  driver.last.emitLive(textStart(2, "m1", 0), textDelta(3, "m1", 0, "orphan"));
  await tick();
  let resetRightAfter: boolean | undefined;
  const off = h.bus.subscribe(rt.agent.id, (m: ServerMessage) => {
    if (m.type !== "session_event" || m.event.event.type !== "turn_end") return;
    const before = liveFrames().length;
    queueMicrotask(() => {
      resetRightAfter = liveFrames().length === before + 1 && liveFrames().at(-1)?.reset === true;
    });
  });
  driver.last.emitAt(5, ev.usage(), ev.end());
  await rt.settled();
  off();
  expect(resetRightAfter).toBe(true);
});
