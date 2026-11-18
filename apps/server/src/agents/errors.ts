export class AgentStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentStartError";
  }
}
export class NoOpenTurnError extends Error {
  constructor() {
    super("Nothing to interrupt");
    this.name = "NoOpenTurnError";
  }
}
