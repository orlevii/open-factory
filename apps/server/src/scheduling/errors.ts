import { ApiError } from "../errors.ts";

/**
 * A refused schedule action: a sentence that says what to do, an HTTP status and an optional field. An `ApiError`, so
 * the REST error handler renders it and the MCP tools print its message.
 */
export class ScheduleError extends ApiError {
  constructor(
    code: string,
    message: string,
    override readonly status: 400 | 403 | 404 | 409,
    readonly field?: string,
  ) {
    super(status, code, message, field ? { fields: { [field]: message } } : {});
    this.name = "ScheduleError";
  }
}
