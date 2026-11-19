export type StartFix = "credentials" | "secrets" | "projects" | "edit_agent" | "resync";

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
export class NoOpenTurnError extends Error {
  constructor() {
    super("Nothing to interrupt");
    this.name = "NoOpenTurnError";
  }
}
