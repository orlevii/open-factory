import type {
  AgentDetail,
  AgentSummary,
  AnyEvent,
  EventsPage,
  SessionEvent,
} from "@open-factory/shared";

let seq = 0;
const at = "2026-11-18T10:00:00.000Z";
export const se = (event: AnyEvent, turnId: string | null = "t1"): SessionEvent => ({
  seq: ++seq,
  agentSlug: "dev",
  turnId,
  at,
  event,
});
export const resetSeq = () => {
  seq = 0;
};

/** A complete AgentSummary: a root, local, active agent from the `dev` template. */
export const agentSummary = (over: Partial<AgentSummary> = {}): AgentSummary => ({
  slug: "dev",
  displayName: "Dev agent",
  description: "",
  status: "idle",
  turnOpen: false,
  runtime: "local",
  kind: "persistent",
  template: "dev",
  reportsTo: null,
  reports: 0,
  openTasks: 0,
  credential: "work",
  projects: [],
  depth: 0,
  archivedAt: null,
  restartPending: false,
  restartWaitingOn: 0,
  waitingOn: { tasks: [], crons: 0 },
  crons: [],
  cronZone: "UTC",
  stopCronsPending: false,
  scheduleCount: 0,
  avatarVersion: null,
  ...over,
});

export const detail = (
  over: Partial<AgentSummary> = {},
  queue: AgentDetail["queue"] = [],
  lastSeq = 10,
): AgentDetail => ({ agent: agentSummary(over), queue, lastSeq });

export function conversation(): EventsPage {
  resetSeq();
  return {
    hasMore: { before: false, after: false },
    events: [
      se({ type: "process_started", resumed: false }, null),
      se(
        {
          type: "message_in",
          messages: [
            {
              id: "m1",
              from: "@or",
              fromKind: "human",
              kind: "message",
              urgent: true,
              body: "Please **list** files",
            },
          ],
        },
        null,
      ),
      se(
        {
          type: "session_started",
          sessionId: "s",
          model: "claude-haiku-5-5",
          cwd: "/w",
          claudeCodeVersion: "2.1.327",
        },
        null,
      ),
      se({ type: "turn_started" }),
      se({ type: "tool_call", toolUseId: "tu1", name: "Bash", input: { command: "ls -la" } }),
      se({ type: "tool_result", toolUseId: "tu1", content: "README.md\nsrc", isError: false }),
      se({ type: "assistant_text", text: "Two entries." }),
      se({
        type: "usage",
        model: "m",
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        durationMs: 1,
        numTurns: 1,
      }),
      se({ type: "turn_end", isError: false, terminalReason: "completed", numTurns: 1 }),
      se(
        {
          type: "compacted",
          trigger: "manual",
          preTokens: 27545,
          postTokens: 15259,
          summary: "This session is being continued…",
        },
        "t2",
      ),
    ],
  };
}
