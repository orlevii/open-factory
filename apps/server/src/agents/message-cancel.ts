import type { MessageRow } from "@open-factory/db";

/**
 * U3 §6.4 (Q26, D2): the message isn't the caller's to cancel or restore. Only a `kind = 'message'` row the session
 * user sent to this agent qualifies; task comments, scheduled rows, notices and other people's messages never do.
 * One answer for all of them (and for an unknown id), so the route never says whose a message is. `403 not_sender`.
 */
export class NotSenderError extends Error {
  readonly code = "not_sender";
  constructor() {
    super("Only the person who sent this message can cancel it.");
    this.name = "NotSenderError";
  }
}

/** U3 §6.4: the message was already handed to the agent (in flight, awaiting its turn, or written). `409`. */
export class AlreadyDeliveredError extends Error {
  readonly code = "already_delivered";
  constructor() {
    super("The message was already delivered.");
    this.name = "AlreadyDeliveredError";
  }
}

/** U3 §6.4: a restore to a terminated or archived agent. `409 agent_ended`. */
export class AgentEndedError extends Error {
  readonly code = "agent_ended";
  constructor(slug: string) {
    super(`@${slug} has ended and can't receive messages.`);
    this.name = "AgentEndedError";
  }
}

/** Throws `NotSenderError` unless `row` is a direct message from `userId` to `agentId` (U3 §6.4, Q26, D2). */
export function assertSender(
  row: MessageRow | undefined,
  o: { agentId: string; userId: string },
): asserts row is MessageRow {
  if (row?.kind !== "message" || row.toAgentId !== o.agentId || row.fromUserId !== o.userId)
    throw new NotSenderError();
}
