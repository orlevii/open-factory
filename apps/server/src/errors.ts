import type { FastifyError, FastifyInstance } from "fastify";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";

export function registerErrorHandlers(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(err) || err.validation) {
      return reply.code(400).send({ error: { code: "validation_error", message: err.message } });
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
