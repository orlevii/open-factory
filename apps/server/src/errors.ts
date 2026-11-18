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
    return reply.code(status).send({
      error: {
        code: status === 500 ? "internal_error" : (err.code ?? "bad_request"),
        message: status === 500 ? "Internal error" : err.message,
      },
    });
  });
}

export const notFoundBody = { error: { code: "not_found", message: "Not found" } } as const;
