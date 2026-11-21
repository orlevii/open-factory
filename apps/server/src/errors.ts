import type { FastifyError, FastifyInstance } from "fastify";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const FIELD_STATUS: Record<string, number> = { slug_taken: 409, folder_exists: 409 };
export class FieldError extends ApiError {
  constructor(field: string, message: string, code = "validation_error") {
    super(FIELD_STATUS[code] ?? 400, code, message, { fields: { [field]: message } });
  }
}

export function registerErrorHandlers(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError, request, reply) => {
    if (err instanceof ApiError) {
      return reply
        .code(err.status)
        .send({ error: { code: err.code, message: err.message, ...err.extra } });
    }
    if (hasZodFastifySchemaValidationErrors(err) || err.validation) {
      // fastify-type-provider-zod puts one item per issue on err.validation; instancePath is "/slug".
      const fields: Record<string, string> = {};
      for (const issue of err.validation ?? []) {
        const field = issue.instancePath.split("/")[1];
        if (field && !(field in fields)) fields[field] = issue.message ?? "Invalid value";
      }
      // The issue's own sentence, never Fastify's "body/body must be ..." path-prefixed message.
      const first = err.validation?.[0]?.message;
      return reply
        .code(400)
        .send({ error: { code: "validation_error", message: first ?? "Invalid request", fields } });
    }
    const status =
      err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) request.log.error({ err }, "unhandled error");
    // Fastify's own codes (FST_ERR_CTP_EMPTY_JSON_BODY, ...) are internals, not API codes.
    const code = !err.code || err.code.startsWith("FST_") ? "bad_request" : err.code;
    return reply.code(status).send({
      error: {
        code: status === 500 ? "internal_error" : code,
        message: status === 500 ? "Internal error" : err.message,
      },
    });
  });
}

export const notFoundBody = { error: { code: "not_found", message: "Not found" } } as const;
