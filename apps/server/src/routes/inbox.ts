import { inboxPageSchema } from "@open-factory/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { InvalidCursorError } from "../agents/errors.ts";
import { requireUser } from "../auth/require-user.ts";
import { FieldError } from "../errors.ts";

const inboxQuerySchema = z.object({
  before: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** Spec §11: the caller's inbox, newest first. Human session only: an agent token gets 401 like no auth. */
export const inboxRoutes: FastifyPluginAsyncZod = async (app) => {
  // onRequest: auth before validation (401 before 400).
  app.addHook("onRequest", requireUser);

  app.get(
    "/api/inbox",
    { schema: { querystring: inboxQuerySchema, response: { 200: inboxPageSchema } } },
    async (req) => {
      if (!req.user) throw new Error("requireUser did not set request.user");
      try {
        // The response schema validates and serializes it (no second parse here).
        return await app.store.inboxPage(req.user.id, req.query.before, req.query.limit);
      } catch (err) {
        if (err instanceof InvalidCursorError) throw new FieldError("before", err.message);
        throw err;
      }
    },
  );
};
