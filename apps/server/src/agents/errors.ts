import { ApiError } from "../errors.ts";

export type StartFix =
  | "credentials"
  | "secrets"
  | "projects"
  | "edit_agent"
  | "runtime"
  | "image"
  | "template"
  | "config";

export class AgentStartError extends Error {
  /** The message without its advice (what is wrong, not what to do): a spawned agent's variant ends differently. */
  readonly diagnosis: string;
  constructor(
    message: string,
    readonly fix?: StartFix,
    diagnosis?: string,
    /** Redacted, capped output that explains the failure (a failed command's); goes into the error event's `detail`. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = "AgentStartError";
    this.diagnosis = diagnosis ?? message;
  }
}
/**
 * S7 §8: a spawned agent can't be edited or configured, so a start error whose fix is one of those drops
 * the fix and its advice: the diagnosis ends with "Terminate it and spawn a new one." instead. Other errors are
 * returned unchanged.
 */
export function forSpawnedAgent(err: AgentStartError): AgentStartError {
  if (err.fix !== "edit_agent" && err.fix !== "config") return err;
  return new AgentStartError(`${err.diagnosis} Terminate it and spawn a new one.`);
}

export class AgentArchivedError extends Error {
  constructor(slug: string) {
    super(`@${slug} is archived. Restore it first.`);
    this.name = "AgentArchivedError";
  }
}
/** S7 §8: the agent was terminated; it is read-only forever (REST answers `409 agent_terminated`). */
export class AgentTerminatedError extends Error {
  constructor(slug: string) {
    super(`@${slug} was terminated and can't receive messages.`);
    this.name = "AgentTerminatedError";
  }
}

/** Why Restart or Start a new session is refused (spec §9.7); the route answers 409 with the code. */
export type RecoveryRefusal =
  | "attempt_in_progress"
  | "starting"
  | "stopping"
  | "compacting"
  | "lost_work"
  | "resume_unrecoverable"
  | "runtime_disabled"
  | "reset_not_allowed";

export class RecoveryRefusedError extends Error {
  constructor(
    readonly code: RecoveryRefusal,
    message: string,
    /** `lost_work`: what a forced restart would stop, so a caller can show it (I7 §9.2). */
    readonly data?: { tasks: string[]; crons: string[] },
  ) {
    super(message);
    this.name = "RecoveryRefusedError";
  }
}
export class NoOpenTurnError extends Error {
  constructor() {
    super("Nothing to interrupt");
    this.name = "NoOpenTurnError";
  }
}

/** U3 §6.1 (D5): a compaction is running, and the runtime never interrupts one; the route answers 409 `compacting`. */
export class CompactingError extends Error {
  readonly code = "compacting";
  constructor() {
    super("A compaction is running");
    this.name = "CompactingError";
  }
}

/** U3 §13.3: the agent's harness process can't write slash commands; the route answers 501 `commands_unsupported`. */
export class CommandsUnsupportedError extends Error {
  readonly code = "commands_unsupported";
  constructor() {
    super("This agent's harness can't run slash commands.");
    this.name = "CommandsUnsupportedError";
  }
}

/** I1 §7: an agent may have one command queued for itself at a time. */
export class SelfCommandPendingError extends Error {
  readonly code = "self_command_pending";
  constructor() {
    super("You already have a command queued for yourself.");
    this.name = "SelfCommandPendingError";
  }
}

/** An inbox cursor that doesn't decode to `created_at|id` (spec §11); the route answers 400. */
export class InvalidCursorError extends Error {
  constructor() {
    super("Invalid cursor");
    this.name = "InvalidCursorError";
  }
}

/** Why Stop crons is refused (S9 §10.3); both are `409`. */
export class StopCronsError extends ApiError {
  constructor(code: "no_crons" | "stopping", slug: string) {
    super(
      409,
      code,
      code === "no_crons"
        ? `@${slug} has no crons.`
        : `@${slug} is already stopping; its crons stop with it.`,
    );
    this.name = "StopCronsError";
  }
}

/** An agent actor asked for something only a human may do (spec §7.2): a 403 for REST, a tool error for MCP. */
export class OrgRefusedError extends ApiError {
  constructor(message: string) {
    super(403, "org_refused", message);
    this.name = "OrgRefusedError";
  }
}
