import { anyEventSchema, type HarnessEvent } from "@open-factory/shared";
import { describe, expect, test } from "vitest";
import { fixtureNames, readFixture } from "../test-fixtures.ts";
import { createMapperState, flushMapper, mapLine } from "./mapper.ts";

/** Maps a whole fixture. `manualCompactAt` lists 1-based line numbers before which the driver would
 *  have written `/compact` (so the mapper knows a following compaction failure is manual). */
function mapFixture(name: string, opts: { resumed?: boolean; manualCompactAt?: number[] } = {}) {
  const unmapped: string[] = [];
  const state = createMapperState({
    resumed: opts.resumed ?? false,
    onUnmapped: (k) => unmapped.push(k),
  });
  const events: HarnessEvent[] = [];
  readFixture(name).forEach((line, i) => {
    if (opts.manualCompactAt?.includes(i + 1)) state.manualCompactPending = true;
    events.push(...mapLine(line, state));
  });
  events.push(...flushMapper(state));
  return { events, unmapped, types: events.map((e) => e.type) };
}
const ofType = <T extends HarnessEvent["type"]>(evs: HarnessEvent[], t: T) =>
  evs.filter((e): e is Extract<HarnessEvent, { type: T }> => e.type === t);

describe("every fixture", () => {
  test.each(fixtureNames())("%s: valid events, nothing unmapped, no thinking", (name) => {
    const { events, unmapped } = mapFixture(name, { resumed: name.includes("resume") });
    for (const e of events) expect(anyEventSchema.safeParse(e).success).toBe(true);
    expect(unmapped).toEqual([]);
    // session_started at most once per process although system/init repeats every turn
    expect(ofType(events, "session_started").length).toBeLessThanOrEqual(1);
    // one turn_started per system/init
    const inits = readFixture(name).filter(
      (l) => (l as { subtype?: string }).subtype === "init",
    ).length;
    expect(ofType(events, "turn_started")).toHaveLength(inits);
  });
});

test("rate-limit-event-allowed: one plain turn; allowed rate limit dropped", () => {
  const { events, types } = mapFixture("rate-limit-event-allowed");
  expect(types).toEqual(["session_started", "turn_started", "assistant_text", "usage", "turn_end"]);
  expect(events[0]).toEqual({
    type: "session_started",
    sessionId: "9b0f104d-91be-45f5-9c3f-e762d832993b",
    model: "claude-haiku-5-5",
    cwd: "/spike/work/a",
    claudeCodeVersion: "2.1.327",
  });
  expect(events[2]).toEqual({ type: "assistant_text", text: "pong" });
  expect(ofType(events, "usage")[0]).toMatchObject({
    model: "claude-haiku-5-5",
    outputTokens: 4,
    numTurns: 1,
  });
  expect(ofType(events, "usage")[0]?.costUsd).toBeCloseTo(0.0015537, 6);
  expect(ofType(events, "turn_end")[0]).toEqual({
    type: "turn_end",
    isError: false,
    terminalReason: "completed",
    numTurns: 1,
  });
});

test("interrupt-then-message: interrupted turn is a turn_end error, not an error event", () => {
  const { events, types } = mapFixture("interrupt-then-message");
  expect(types).toEqual([
    "session_started",
    "turn_started",
    "tool_call",
    "tool_result",
    "usage",
    "turn_end",
    "turn_started",
    "assistant_text",
    "usage",
    "turn_end",
  ]);
  expect(ofType(events, "tool_call")[0]).toMatchObject({ name: "Bash" });
  expect(ofType(events, "turn_end")[0]).toMatchObject({
    isError: true,
    terminalReason: "aborted_tools",
  });
  expect(ofType(events, "error")).toEqual([]);
});

test("manual-compact: compact turn, summary attached, failure is manual, synthetic text dropped", () => {
  const { events, types } = mapFixture("manual-compact", { manualCompactAt: [5, 12] });
  expect(types.slice(5)).toEqual([
    "turn_started",
    "compacted",
    "usage",
    "turn_end", // successful /compact
    "compact_failed",
    "turn_started",
    "usage",
    "turn_end", // failing /compact
  ]);
  const c = ofType(events, "compacted")[0];
  expect(c).toMatchObject({ trigger: "manual", preTokens: 27545, postTokens: 15259 });
  expect(c?.summary).toMatch(/^This session is being continued/);
  expect(ofType(events, "turn_end").slice(1)).toEqual([
    { type: "turn_end", isError: false, command: "compact", numTurns: 0 },
    { type: "turn_end", isError: false, command: "compact", numTurns: 0 },
  ]);
  expect(ofType(events, "compact_failed")).toEqual([
    { type: "compact_failed", trigger: "manual", error: "Not enough messages to compact." },
  ]);
  expect(ofType(events, "assistant_text").map((e) => e.text)).toEqual(["OK"]);
});

test("auto-compaction: auto compacted events with summaries; too_few_groups is a quiet auto failure", () => {
  const { events } = mapFixture("auto-compaction");
  const compacted = ofType(events, "compacted");
  expect(compacted.length).toBe(4);
  expect(compacted[0]).toMatchObject({ trigger: "auto", preTokens: 129052, postTokens: 32412 });
  for (const c of compacted) expect(c.summary).toMatch(/^This session is being continued/);
  expect(ofType(events, "compact_failed").every((f) => f.trigger === "auto")).toBe(true);
  expect(ofType(events, "error")).toEqual([]);
});

test("error-refusal-and-failed-compaction: exactly one refusal error per turn", () => {
  const { events } = mapFixture("error-refusal-and-failed-compaction");
  const errors = ofType(events, "error");
  expect(errors).toHaveLength(4);
  expect(errors.every((e) => e.source === "refusal")).toBe(true);
  expect(
    ofType(events, "turn_end").every((t) => t.isError && t.terminalReason === "api_error"),
  ).toBe(true);
  expect(ofType(events, "compact_failed").length).toBe(6);
});

test("error-model-not-found: one api error from the synthetic message, no assistant text", () => {
  const { events } = mapFixture("error-model-not-found");
  const errors = ofType(events, "error");
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ source: "api" });
  expect(errors[0]?.message).toMatch(/issue with the selected model/);
  expect(ofType(events, "assistant_text")).toEqual([]);
});

test("error-resume-missing-session: a result before any init is only a resume error", () => {
  expect(mapFixture("error-resume-missing-session", { resumed: true }).events).toEqual([
    {
      type: "error",
      source: "resume",
      message: "No conversation found with session ID: 00000000-0000-4000-8000-000000000000",
    },
  ]);
  expect(mapFixture("error-resume-missing-session", { resumed: false }).events[0]).toMatchObject({
    source: "spawn",
  });
});

test("resume-after-sigkill-orphans: orphan reports, then an origin-tagged turn, then the real turn", () => {
  const { events, types } = mapFixture("resume-after-sigkill-orphans", { resumed: true });
  expect(types.slice(0, 6)).toEqual([
    "background_task_finished",
    "background_task_finished",
    "session_started",
    "turn_started",
    "usage",
    "turn_end",
  ]);
  expect(ofType(events, "background_task_finished")[0]).toMatchObject({ status: "stopped" });
  expect(ofType(events, "background_task_finished")[0]?.summary).toMatch(/^Orphaned/);
  const ends = ofType(events, "turn_end");
  expect(ends[0]).toMatchObject({ originKind: "task-notification", numTurns: 0 });
  expect(ends[1]?.originKind).toBeUndefined();
});

test("background-bash-start-finish: background task lifecycle and a self-started turn", () => {
  const { events } = mapFixture("background-bash-start-finish");
  expect(ofType(events, "background_task_started")).toEqual([
    {
      type: "background_task_started",
      taskId: "bu2glf4ey",
      toolUseId: expect.any(String),
      taskType: "local_bash",
      description: "Run delayed echo in background",
    },
  ]);
  expect(ofType(events, "background_task_finished")).toEqual([
    {
      type: "background_task_finished",
      taskId: "bu2glf4ey",
      status: "completed",
      summary: expect.any(String),
    },
  ]);
  expect(ofType(events, "background_tasks").map((b) => b.tasks.length)).toEqual([1, 0]);
  expect(ofType(events, "turn_end").map((t) => t.originKind)).toEqual([
    undefined,
    "task-notification",
  ]);
});

test.each(["midturn-messages-absorbed", "user-message-priority-now"])(
  "%s: a long foreground Bash is not a background task",
  (name) => {
    const { events } = mapFixture(name);
    expect(ofType(events, "background_task_started")).toEqual([]);
    expect(ofType(events, "background_task_finished")).toEqual([]);
  },
);

test("cron-create-fire-delete: cron ids, and the firing turn is tagged cron", () => {
  const { events } = mapFixture("cron-create-fire-delete");
  expect(ofType(events, "cron_created")).toEqual([
    {
      type: "cron_created",
      cronId: "046617ac",
      recurring: true,
      humanSchedule: "Every minute",
      nextFireAt: expect.any(Number),
    },
  ]);
  expect(ofType(events, "cron_deleted")).toEqual([{ type: "cron_deleted", cronId: "046617ac" }]);
  expect(ofType(events, "turn_end").map((t) => t.originKind)).toEqual([
    undefined,
    "cron",
    undefined,
  ]);
});

test("cron-oneshot: one-shot cron, firing tagged cron, no cron_deleted", () => {
  const { events } = mapFixture("cron-oneshot");
  expect(ofType(events, "cron_created")[0]).toMatchObject({ cronId: "42441813", recurring: false });
  expect(ofType(events, "cron_deleted")).toEqual([]);
  expect(ofType(events, "turn_end").map((t) => t.originKind)).toEqual([
    undefined,
    "cron",
    undefined,
  ]);
});

test("permission-denied: classifier denial", () => {
  const { events } = mapFixture("permission-denied");
  expect(ofType(events, "permission_denied")[0]).toMatchObject({
    toolName: "Bash",
    reasonType: "classifier",
  });
});

test("usage is per turn even though result totals are cumulative", () => {
  const { events } = mapFixture("error-refusal-and-failed-compaction");
  const costs = ofType(events, "usage").map((u) => u.costUsd);
  // cumulative totals were 0.0117 → 0.127 → 0.404 → 0.776; per-turn deltas are all well below the totals
  expect(costs[0]).toBeCloseTo(0.0117, 3);
  expect(costs[3]).toBeLessThan(0.5);
  expect(costs.reduce((a, b) => a + b, 0)).toBeCloseTo(0.776, 2);
});

test("rate limits map only when rejected; allowed_warning and overageStatus are ignored", () => {
  const s = createMapperState({ resumed: false });
  const rl = (status: string) => ({
    type: "rate_limit_event",
    rate_limit_info: {
      status,
      resetsAt: 1795027800,
      rateLimitType: "five_hour",
      overageStatus: "rejected",
      utilization: 0.97,
    },
  });
  expect(mapLine(rl("allowed"), s)).toEqual([]);
  expect(mapLine(rl("allowed_warning"), s)).toEqual([]);
  expect(mapLine(rl("rejected"), s)).toEqual([
    {
      type: "rate_limited",
      status: "rejected",
      resetsAt: 1795027800,
      rateLimitType: "five_hour",
      utilization: 0.97,
    },
  ]);
});

test("unknown types are reported once and yield nothing", () => {
  const seen: string[] = [];
  const s = createMapperState({ resumed: false, onUnmapped: (k) => seen.push(k) });
  expect(mapLine({ type: "brand_new" }, s)).toEqual([]);
  expect(mapLine({ type: "brand_new" }, s)).toEqual([]);
  expect(mapLine({ type: "system", subtype: "brand_new" }, s)).toEqual([]);
  expect(seen).toEqual(["brand_new", "system/brand_new"]);
});
