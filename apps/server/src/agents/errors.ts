export type StartFix = "credentials" | "secrets" | "projects" | "edit_agent" | "resync" | "runtime";

export class AgentStartError extends Error {
  constructor(
    message: string,
    readonly fix?: StartFix,
  ) {
    super(message);
    this.name = "AgentStartError";
  }
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
