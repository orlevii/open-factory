export type StartFix = "credentials" | "secrets" | "projects" | "edit_agent" | "resync" | "runtime";

export class AgentStartError extends Error {
  /** The message without its advice (what is wrong, not what to do): a spawned agent's variant ends differently. */
  readonly diagnosis: string;
  constructor(
    message: string,
    readonly fix?: StartFix,
    diagnosis?: string,
  ) {
    super(message);
    this.name = "AgentStartError";
    this.diagnosis = diagnosis ?? message;
  }
}
/**
 * S7 §8: a spawned agent can't be edited or re-synced, so a start error whose fix is one of those drops the fix and
 * its advice: the diagnosis ends with "Terminate it and spawn a new one." instead. Other errors are returned unchanged.
 */
export function forSpawnedAgent(err: AgentStartError): AgentStartError {
  if (err.fix !== "edit_agent" && err.fix !== "resync") return err;
  return new AgentStartError(`${err.diagnosis} Terminate it and spawn a new one.`);
}

export class AgentArchivedError extends Error {
  constructor(slug: string) {
    super(`@${slug} is archived. Restore it first.`);
    this.name = "AgentArchivedError";
  }
}
/** Why Restart or Start a new session is refused (spec §9.7); the route answers 409 with the code. */
export type RecoveryRefusal =
  | "not_errored"
  | "attempt_in_progress"
  | "resume_unrecoverable"
  | "runtime_disabled"
  | "reset_not_allowed";

export class RecoveryRefusedError extends Error {
  constructor(
    readonly code: RecoveryRefusal,
    message: string,
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

/** An inbox cursor that doesn't decode to `created_at|id` (spec §11); the route answers 400. */
export class InvalidCursorError extends Error {
  constructor() {
    super("Invalid cursor");
    this.name = "InvalidCursorError";
  }
}
