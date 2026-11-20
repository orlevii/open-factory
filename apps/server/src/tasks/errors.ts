/** A refused task action: a sentence that says what to do, an HTTP status for REST and an optional field. */
export class TaskError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 409,
    readonly field?: string,
  ) {
    super(message);
    this.name = "TaskError";
  }
}
