import { readFileSync } from "node:fs";
import { anyEventSchema, type HarnessEvent, toolMetaSchema } from "@open-factory/shared";
import { describe, expect, test } from "vitest";
import { FIXTURES_DIR, fixtureNames, readFixture } from "../test-fixtures.ts";
import { createMapperState, flushMapper, mapLine, toolMetaOf } from "./mapper.ts";

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
  // `rate_limit_status` is not a timeline event and shows up wherever the CLI interleaves one: sequences ignore it.
  const types = events.map((e) => e.type).filter((t) => t !== "rate_limit_status");
  return { events, unmapped, types };
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

test("rate-limit-event-allowed: one plain turn; the allowed rate limit is a status, not a timeline event", () => {
  const { events, types } = mapFixture("rate-limit-event-allowed");
  expect(ofType(events, "rate_limit_status")).toHaveLength(1);
  expect(types).toEqual(["session_started", "turn_started", "assistant_text", "usage", "turn_end"]);
  expect(events[0]).toEqual({
    type: "session_started",
    sessionId: "9b0f104d-91be-45f5-9c3f-e762d832993b",
    model: "claude-haiku-5-5",
    cwd: "/spike/work/a",
    claudeCodeVersion: "2.1.327",
    mcpServers: [],
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
      durable: false,
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

test("every rate limit event maps to rate_limit_status; only rejected also emits rate_limited", () => {
  const s = createMapperState({ resumed: false });
  const rl = (status: string, utilization = 0.97) => ({
    type: "rate_limit_event",
    rate_limit_info: {
      status,
      resetsAt: 1795027800,
      rateLimitType: "five_hour",
      overageStatus: "rejected",
      utilization,
    },
  });
  const status = (st: string, utilization: number) => ({
    type: "rate_limit_status",
    status: st,
    rateLimitType: "five_hour",
    resetsAt: 1795027800,
    utilization,
  });
  expect(mapLine(rl("allowed", 0.1), s)).toEqual([status("allowed", 0.1)]);
  expect(mapLine(rl("allowed_warning", 0.82), s)).toEqual([status("allowed_warning", 0.82)]);
  expect(mapLine(rl("rejected"), s)).toEqual([
    status("rejected", 0.97),
    {
      type: "rate_limited",
      status: "rejected",
      resetsAt: 1795027800,
      rateLimitType: "five_hour",
      utilization: 0.97,
    },
  ]);
});

test("a real rate_limit_event carries utilization only inside unifiedWindows", () => {
  const lines = readFileSync(`${FIXTURES_DIR}rate-limit-event-live-allowed.ndjson`, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  const s = createMapperState({ resumed: false });
  const out = lines.flatMap((l) => mapLine(l, s));
  expect(out).toEqual([
    {
      type: "rate_limit_status",
      status: "allowed",
      rateLimitType: "five_hour",
      resetsAt: 1795209600,
      utilization: 0.01,
    },
  ]);
});

test("a real-shape rejected event: rate_limited carries the window's utilization and reset too", () => {
  const s = createMapperState({ resumed: false });
  const out = mapLine(
    {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        rateLimitType: "five_hour",
        unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1795209600, status: "rejected" } },
      },
    },
    s,
  );
  expect(out).toEqual([
    {
      type: "rate_limit_status",
      status: "rejected",
      rateLimitType: "five_hour",
      utilization: 1,
      resetsAt: 1795209600,
    },
    {
      type: "rate_limited",
      status: "rejected",
      rateLimitType: "five_hour",
      utilization: 1,
      resetsAt: 1795209600,
    },
  ]);
});

test("a rate_limit_event without rateLimitType: the status has no type rather than an invented one", () => {
  const s = createMapperState({ resumed: false });
  expect(
    mapLine(
      { type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1795209600 } },
      s,
    ),
  ).toEqual([{ type: "rate_limit_status", status: "allowed", resetsAt: 1795209600 }]);
});

test("rate_limit_status without a known status is not invented", () => {
  const s = createMapperState({ resumed: false });
  expect(mapLine({ type: "rate_limit_event", rate_limit_info: { status: "weird" } }, s)).toEqual(
    [],
  );
});

test("unknown types are reported once and yield nothing", () => {
  const seen: string[] = [];
  const s = createMapperState({ resumed: false, onUnmapped: (k) => seen.push(k) });
  expect(mapLine({ type: "brand_new" }, s)).toEqual([]);
  expect(mapLine({ type: "brand_new" }, s)).toEqual([]);
  expect(mapLine({ type: "system", subtype: "brand_new" }, s)).toEqual([]);
  expect(seen).toEqual(["brand_new", "system/brand_new"]);
});

// Spec §6.2: every dropped kind yields nothing (and is not reported as unmapped).
// Minimal lines, shaped after the fixtures.
const SID = { session_id: "s-1", uuid: "u-1" };
const dropped: [string, unknown][] = [
  [
    "system/thinking_tokens",
    {
      type: "system",
      subtype: "thinking_tokens",
      estimated_tokens: 50,
      estimated_tokens_delta: 50,
      ...SID,
    },
  ],
  [
    "system/commands_changed",
    {
      type: "system",
      subtype: "commands_changed",
      commands: [{ name: "x", description: "y", argumentHint: "" }],
      ...SID,
    },
  ],
  [
    "system/task_updated",
    {
      type: "system",
      subtype: "task_updated",
      task_id: "t1",
      run_id: "r1",
      patch: { status: "completed", end_time: 1 },
      ...SID,
    },
  ],
  [
    "system/task_progress",
    {
      type: "system",
      subtype: "task_progress",
      task_id: "t1",
      run_id: "r1",
      tool_use_id: "toolu_1",
      description: "Running",
      usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 },
      last_tool_name: "Bash",
      ...SID,
    },
  ],
  [
    "system/informational",
    {
      type: "system",
      subtype: "informational",
      content: "safeguards notice",
      level: "notice",
      ...SID,
    },
  ],
  [
    "system/hook_started",
    { type: "system", subtype: "hook_started", hook_id: "h1", hook_name: "SessionStart", ...SID },
  ],
  [
    "system/hook_response",
    {
      type: "system",
      subtype: "hook_response",
      hook_id: "h1",
      hook_name: "SessionStart",
      output: "",
      exit_code: 0,
      ...SID,
    },
  ],
  [
    "system/hook_progress",
    { type: "system", subtype: "hook_progress", hook_id: "h1", hook_name: "SessionStart", ...SID },
  ],
  [
    "system/status compacting",
    { type: "system", subtype: "status", status: "compacting", compact_output_chars: 0, ...SID },
  ],
  [
    "system/status success",
    { type: "system", subtype: "status", status: null, compact_result: "success", ...SID },
  ],
  [
    "control_response",
    {
      type: "control_response",
      response: { subtype: "success", request_id: "r", response: { still_queued: [] } },
    },
  ],
  [
    "command_lifecycle",
    {
      type: "command_lifecycle",
      command_uuid: "c1",
      state: "started",
      wakeup_source: "schedule_wakeup",
      ...SID,
    },
  ],
  [
    "command_lifecycle completed",
    { type: "command_lifecycle", command_uuid: "c1", state: "completed", ...SID },
  ],
  [
    "user isReplay",
    {
      type: "user",
      message: { role: "user", content: "<local-command-stdout>Compacted </local-command-stdout>" },
      parent_tool_use_id: null,
      isReplay: true,
      ...SID,
    },
  ],
  [
    "user isReplay tool_result",
    {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "x" }],
      },
      isReplay: true,
      ...SID,
    },
  ],
  [
    "user text (not a summary)",
    {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "[Request interrupted by user for tool use]" }],
      },
      parent_tool_use_id: null,
      ...SID,
    },
  ],
  [
    "user string content",
    { type: "user", message: { role: "user", content: "plain text" }, ...SID },
  ],
  [
    "synthetic assistant with local_command_source",
    {
      type: "assistant",
      message: {
        model: "<synthetic>",
        role: "assistant",
        content: [{ type: "text", text: "Not enough messages to compact." }],
        stop_reason: "end_turn",
      },
      parent_tool_use_id: null,
      local_command_source:
        "<local-command-stdout>Not enough messages to compact.</local-command-stdout>",
      local_command_run: { command: "compact", args: "" },
      ...SID,
    },
  ],
  [
    "assistant thinking block",
    {
      type: "assistant",
      message: {
        model: "claude-haiku-5-5",
        role: "assistant",
        content: [{ type: "thinking", thinking: "", signature: "sig" }],
        stop_reason: null,
      },
      parent_tool_use_id: null,
      ...SID,
    },
  ],
];

describe("spec §6.2 drops", () => {
  test.each(dropped)("%s yields nothing", (_name, line) => {
    const seen: string[] = [];
    // Mid-turn state (init seen), the realistic context for every dropped line.
    const s = createMapperState({ resumed: false, onUnmapped: (k) => seen.push(k) });
    mapLine(
      {
        type: "system",
        subtype: "init",
        session_id: "s-1",
        model: "m",
        cwd: "/w",
        claude_code_version: "2.1.327",
      },
      s,
    );
    expect(mapLine(line, s)).toEqual([]);
    expect(seen).toEqual([]);
  });
});

test("usage falls back to cumulative modelUsage/total_cost_usd deltas without model_usage_since_last_result", () => {
  const s = createMapperState({ resumed: false });
  const init = {
    type: "system",
    subtype: "init",
    session_id: "s-1",
    model: "m-a",
    cwd: "/w",
    claude_code_version: "2.1.327",
  };
  const result = (modelUsage: Record<string, object>, total: number) => ({
    type: "result",
    subtype: "success",
    is_error: false,
    terminal_reason: "completed",
    duration_ms: 100,
    num_turns: 1,
    total_cost_usd: total,
    modelUsage,
  });
  mapLine(init, s);
  const t1 = ofType(
    mapLine(
      result(
        {
          "m-a": {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadInputTokens: 100,
            cacheCreationInputTokens: 50,
            costUSD: 0.01,
          },
        },
        0.01,
      ),
      s,
    ),
    "usage",
  )[0];
  expect(t1).toMatchObject({
    model: "m-a",
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 100,
    cacheWriteTokens: 50,
    durationMs: 100,
    numTurns: 1,
  });
  expect(t1?.costUsd).toBeCloseTo(0.01, 10);

  mapLine(init, s);
  const t2 = ofType(
    mapLine(
      result(
        {
          "m-a": {
            inputTokens: 25,
            outputTokens: 12,
            cacheReadInputTokens: 300,
            cacheCreationInputTokens: 50,
            costUSD: 0.03,
          },
          "m-b": {
            inputTokens: 4,
            outputTokens: 2,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 0.005,
          },
        },
        0.035,
      ),
      s,
    ),
    "usage",
  )[0];
  // Deltas: m-a +15/+7/+200/+0 at $0.02, m-b (new) +4/+2/0/0 at $0.005; model = largest-cost delta.
  expect(t2).toMatchObject({
    model: "m-a",
    inputTokens: 19,
    outputTokens: 9,
    cacheReadTokens: 200,
    cacheWriteTokens: 0,
  });
  expect(t2?.costUsd).toBeCloseTo(0.025, 10);
});

test("system/model_refusal_fallback maps to a quiet model_fallback, not an error", () => {
  const s = createMapperState({ resumed: false });
  mapLine(
    {
      type: "system",
      subtype: "init",
      session_id: "s-1",
      model: "m",
      cwd: "/w",
      claude_code_version: "2.1.327",
    },
    s,
  );
  expect(
    mapLine(
      {
        type: "system",
        subtype: "model_refusal_fallback",
        message: "Switched to a fallback model",
        fallback_model: "m-2",
        ...SID,
      },
      s,
    ),
  ).toEqual([{ type: "model_fallback", message: "Switched to a fallback model" }]);
  expect(
    mapLine(
      { type: "system", subtype: "model_refusal_fallback", fallback_model: "m-2", ...SID },
      s,
    ),
  ).toEqual([{ type: "model_fallback", message: "m-2" }]);
});

test("error-invalid-oauth-token: api_retry dropped; error code and apiErrorStatus", () => {
  const { events, unmapped } = mapFixture("error-invalid-oauth-token");
  expect(unmapped).toEqual([]);
  const errors = ofType(events, "error");
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ source: "api", code: "authentication_failed" });
  expect(ofType(events, "turn_end")[0]).toMatchObject({ isError: true, apiErrorStatus: 401 });
});

test("permission-deny-rules: one system denial, one derived from tool_result_meta, no duplicates", () => {
  const { events } = mapFixture("permission-deny-rules");
  const denials = ofType(events, "permission_denied");
  expect(denials).toHaveLength(2);
  expect(denials[0]).toMatchObject({ toolName: "Bash", reasonType: "subcommandResults" });
  expect(denials[1]).toMatchObject({
    toolName: "Read",
    reasonType: "rule",
    reason: "File is in a directory that is denied by your permission settings.",
  });
  // the derived denial precedes its tool_result
  const types = events.map((e) => e.type);
  const readDenial = types.indexOf("permission_denied", types.indexOf("permission_denied") + 1);
  expect(types[readDenial + 1]).toBe("tool_result");
});

test("permission-denied (classifier): no derived duplicate", () => {
  const { events } = mapFixture("permission-denied");
  const ids = ofType(events, "permission_denied").map((d) => d.toolUseId);
  expect(new Set(ids).size).toBe(ids.length);
});

test("permission_denials fallback on result for an unreported id", () => {
  const s = createMapperState({ resumed: false });
  mapLine({ type: "system", subtype: "init", session_id: "s", model: "m" }, s);
  mapLine(
    {
      type: "assistant",
      message: { model: "m", content: [{ type: "tool_use", id: "t1", name: "Edit", input: {} }] },
    },
    s,
  );
  const out = mapLine(
    {
      type: "result",
      is_error: false,
      num_turns: 1,
      permission_denials: [{ tool_name: "Edit", tool_use_id: "t1" }],
    },
    s,
  );
  expect(out[0]).toEqual({
    type: "permission_denied",
    toolName: "Edit",
    toolUseId: "t1",
    reasonType: "rule",
    reason: "Denied by a permission rule",
  });
});

test("session_state_changed yields nothing", () => {
  const st = createMapperState({ resumed: false });
  expect(mapLine({ type: "system", subtype: "session_state_changed", state: "idle" }, st)).toEqual(
    [],
  );
});

test("the rejected rate-limit fixture maps to rate_limited", () => {
  const evs = mapFixture("rate-limit-event-rejected").events;
  expect(evs.find((e) => e.type === "rate_limited")).toMatchObject({
    status: "rejected",
    rateLimitType: "five_hour",
  });
});

test("session_started carries the MCP connection results (fixture mcp-http-env-header)", () => {
  const { events } = mapFixture("mcp-http-env-header");
  const s = events.find((e) => e.type === "session_started");
  expect(s).toMatchObject({ mcpServers: [{ name: "factory", status: "connected" }] });
});

test("session_started passes through any MCP status string, including pending", () => {
  const { events } = mapFixture("mcp-plugin-and-project");
  const s = events.find((e) => e.type === "session_started");
  expect(s).toMatchObject({
    mcpServers: [
      { name: "plugin:vplug:plugsrv", status: "connected" },
      { name: "proj", status: "connected" },
    ],
  });
});

// Spec §9.1 (Q16): per-tool meta on tool_result, built from `tool_use_result` and bounded.
describe("tool_result.meta", () => {
  // biome-ignore lint/suspicious/noExplicitAny: fixture lines are parsed JSON
  type Line = Record<string, any>;
  /** The mapped tool_result for the first fixture `user` line matching `pick`. */
  function mapFixtureLine(name: string, pick: (l: Line) => unknown) {
    const line = (readFixture(name) as Line[]).find((l) => l.type === "user" && pick(l));
    if (!line) throw new Error(`no matching line in ${name}`);
    const id = line.message.content.find((b: Line) => b.type === "tool_result").tool_use_id;
    const { events } = mapFixture(name);
    return ofType(events, "tool_result").filter((e) => e.toolUseId === id);
  }
  const toolResult = (out: Extract<HarnessEvent, { type: "tool_result" }>[]) => {
    expect(out).toHaveLength(1);
    return out[0] as Extract<HarnessEvent, { type: "tool_result" }>;
  };

  test("Edit meta from factory-mcp-and-project-symlink-edits: hunks, no originalFile", () => {
    const out = mapFixtureLine(
      "factory-mcp-and-project-symlink-edits",
      (l) => l.tool_use_result?.structuredPatch,
    );
    const meta = toolResult(out).meta;
    expect(meta).toMatchObject({ tool: "Edit" });
    expect(meta).toEqual({
      tool: "Edit",
      hunks: [expect.objectContaining({ oldStart: 1, oldLines: 4, newStart: 1, newLines: 4 })],
    });
    expect(JSON.stringify(meta)).not.toContain("originalFile");
    expect(JSON.stringify(meta)).not.toContain("retries: 3,\n  timeoutMs");
  });

  test("Write create from project-edits-with-additional-directories: type create, empty hunks", () => {
    const out = mapFixtureLine(
      "project-edits-with-additional-directories",
      (l) => l.tool_use_result?.type === "create",
    );
    expect(toolResult(out).meta).toEqual({ tool: "Write", type: "create", hunks: [] });
  });

  test("Bash meta from background-bash-start-finish: backgroundTaskId, interrupted", () => {
    const out = mapFixtureLine(
      "background-bash-start-finish",
      (l) => l.tool_use_result?.backgroundTaskId,
    );
    expect(toolResult(out).meta).toEqual({
      tool: "Bash",
      interrupted: false,
      backgroundTaskId: "bu2glf4ey",
    });
  });

  test("text Read from factory-mcp-and-project-symlink-edits: line range, never the content", () => {
    const out = mapFixtureLine(
      "factory-mcp-and-project-symlink-edits",
      (l) => l.tool_use_result?.type === "text",
    );
    expect(toolResult(out).meta).toEqual({
      tool: "Read",
      kind: "text",
      startLine: 1,
      numLines: 5,
      totalLines: 5,
    });
  });

  test("image Read never copies file.base64 (spike attach-file-path trace)", () => {
    const out = mapFixtureLine("u3/attach-file-path", (l) => l.tool_use_result?.type === "image");
    const meta = toolResult(out).meta;
    expect(meta).toEqual({ tool: "ReadImage", bytes: 185, width: 64, height: 128 });
    expect(JSON.stringify(meta)).not.toContain("base64");
  });

  test("Agent meta: async launch (background-subagent-stdin-closed)", () => {
    const out = mapFixtureLine(
      "background-subagent-stdin-closed",
      (l) => l.tool_use_result?.isAsync,
    );
    expect(toolResult(out).meta).toEqual({ tool: "Agent", async: true });
  });

  test("Agent meta: foreground totals (spike partial-thinking-summaries-forward-subagent)", () => {
    const out = mapFixtureLine(
      "u3/partial-thinking-summaries-forward-subagent",
      (l) => l.tool_use_result?.totalToolUseCount !== undefined,
    );
    expect(toolResult(out).meta).toEqual({
      tool: "Agent",
      toolUses: 0,
      tokens: 12512,
      durationMs: 1082,
    });
  });

  test("Agent meta under the older Task name", () => {
    expect(
      toolMetaOf("Task", { totalToolUseCount: 3, totalTokens: 900, totalDurationMs: 42 }),
    ).toEqual({ tool: "Agent", toolUses: 3, tokens: 900, durationMs: 42 });
    expect(toolMetaOf("Task", { status: "async_launched" })).toEqual({
      tool: "Agent",
      async: true,
    });
  });

  test("a tool with no meta shape (CronCreate) carries none", () => {
    const out = mapFixtureLine("cron-create-fire-delete", (l) => l.tool_use_result?.humanSchedule);
    expect(toolResult(out)).not.toHaveProperty("meta");
  });

  test("a failed Edit (string tool_use_result) carries none", () => {
    expect(toolMetaOf("Edit", "Error: String to replace not found")).toBeUndefined();
  });

  const hunkOf = (n: number, width: number) => ({
    oldStart: n,
    oldLines: 1,
    newStart: n,
    newLines: 1,
    lines: [`-${"a".repeat(width)}`, `+${"b".repeat(width)}`],
  });

  test("hunks stop at 32 KiB serialized and set partial", () => {
    const structuredPatch = Array.from({ length: 40 }, (_, i) => hunkOf(i + 1, 1000));
    const meta = toolMetaOf("MultiEdit", { structuredPatch, originalFile: "x" });
    expect(meta).toMatchObject({ tool: "MultiEdit", partial: true });
    const hunks = (meta as { hunks: unknown[] }).hunks;
    expect(hunks.length).toBeGreaterThan(0);
    expect(hunks.length).toBeLessThan(40);
    expect(Buffer.byteLength(JSON.stringify(hunks))).toBeLessThanOrEqual(32 * 1024);
    expect(hunks).toEqual(structuredPatch.slice(0, hunks.length));
    // one more hunk would have crossed the limit
    expect(
      Buffer.byteLength(JSON.stringify(structuredPatch.slice(0, hunks.length + 1))),
    ).toBeGreaterThan(32 * 1024);
  });

  test("hunks under the limit are all kept, without partial", () => {
    const structuredPatch = Array.from({ length: 3 }, (_, i) => hunkOf(i + 1, 10));
    expect(toolMetaOf("Write", { type: "update", structuredPatch })).toEqual({
      tool: "Write",
      type: "update",
      hunks: structuredPatch,
    });
  });

  test("stderr is cut at 16 KiB, keeping its tail (the final error)", () => {
    const meta = toolMetaOf("Bash", {
      stdout: "",
      stderr: `warning: first\n${"é".repeat(20 * 1024)}\nError: the final failure`,
      interrupted: true,
      isImage: false,
      noOutputExpected: false,
    });
    expect(meta).toMatchObject({ tool: "Bash", interrupted: true });
    const stderr = (meta as { stderr: string }).stderr;
    expect(Buffer.byteLength(stderr)).toBeLessThanOrEqual(16 * 1024);
    expect(Buffer.byteLength(stderr)).toBeGreaterThan(16 * 1024 - 4);
    expect(stderr).not.toContain("warning: first");
    expect(stderr.endsWith("\nError: the final failure")).toBe(true);
    const lead = stderr.slice(0, stderr.indexOf("\n"));
    expect(lead).toBe("é".repeat(lead.length)); // no split code point
  });

  test("a line with two tool_results carries no meta", () => {
    const state = createMapperState({ resumed: false });
    mapLine(
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "toolu_a", name: "Bash", input: { command: "ls" } },
            { type: "tool_use", id: "toolu_b", name: "Bash", input: { command: "pwd" } },
          ],
        },
        ...SID,
      },
      state,
    );
    const out = mapLine(
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "toolu_a", content: "a" },
            { type: "tool_result", tool_use_id: "toolu_b", content: "b" },
          ],
        },
        tool_use_result: { stdout: "b", stderr: "", interrupted: false },
        ...SID,
      },
      state,
    );
    const results = ofType(out, "tool_result");
    expect(results).toHaveLength(2);
    for (const r of results) expect(r).not.toHaveProperty("meta");
  });

  test("every mapped meta parses with the shared schema", () => {
    for (const name of fixtureNames()) {
      const { events } = mapFixture(name, { resumed: name.includes("resume") });
      for (const e of ofType(events, "tool_result"))
        if (e.meta) expect(toolMetaSchema.safeParse(e.meta).success).toBe(true);
    }
  });
});

describe("local command output (U3 §13.3, spike slash-local-commands)", () => {
  // The driver's `in` lines are what it wrote, not stdout: only `out` lines reach the mapper.
  const out = (readFixture("u3/slash-local-commands") as { dir: string }[]).filter(
    (l) => l.dir === "out",
  );
  const mapped = () => {
    const state = createMapperState({ resumed: false });
    return out.flatMap((l) => mapLine(l, state));
  };

  test("/context, /cost and /usage results map to command_output before the turn ends", () => {
    const events = mapped();
    for (const e of events) expect(anyEventSchema.safeParse(e).success).toBe(true);
    const outputs = ofType(events, "command_output");
    expect(outputs.map((e) => e.command)).toEqual(["context", "cost", "usage"]);
    expect(outputs[0]?.text).toMatch(/^## Context Usage\n/);
    expect(outputs[0]?.text).toContain("| Category | Tokens | Percentage |");
    expect(outputs[2]?.text).toMatch(/^Estimated cost: {8}\$0\.0019\n/);
    // The `<synthetic>` assistant line stays dropped: no assistant_text.
    expect(ofType(events, "assistant_text")).toEqual([]);
    const types = events.map((e) => e.type).filter((t) => t !== "turn_started");
    expect(types.slice(0, 4)).toEqual(["session_started", "command_output", "usage", "turn_end"]);
  });

  test("other local commands and empty results map to no command_output", () => {
    const state = createMapperState({ resumed: false });
    mapLine({ type: "system", subtype: "init", session_id: "s", model: "m", cwd: "/w" }, state);
    const r = (local_command: string, result: unknown) =>
      ofType(
        mapLine({ type: "result", subtype: "success", num_turns: 0, local_command, result }, state),
        "command_output",
      );
    expect(r("compact", "Compacted")).toEqual([]);
    expect(r("context", "")).toEqual([]);
    expect(r("usage", undefined)).toEqual([]);
    expect(r("stats", "x")).toEqual([{ type: "command_output", command: "stats", text: "x" }]);
  });
});
