import { ApiError } from "../errors.ts";

/**
 * A refused task action: a sentence that says what to do, an HTTP status and an optional field. An `ApiError`, so the
 * REST error handler renders it (`{error: {code, message, fields?}}`) and the MCP tools print its message.
 */
export class TaskError extends ApiError {
  constructor(
    code: string,
    message: string,
    override readonly status: 400 | 403 | 404 | 409,
    readonly field?: string,
  ) {
    super(status, code, message, field ? { fields: { [field]: message } } : {});
    this.name = "TaskError";
  }
}
