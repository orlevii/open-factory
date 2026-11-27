import { schema } from "@open-factory/db";
import {
  normaliseRef,
  principalsQuerySchema,
  principalsResponseSchema,
} from "@open-factory/shared";
import { inArray } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { requireUser } from "../auth/require-user.ts";
import { loadPrincipalItems } from "../principals/principal-events.ts";

export const principalsRoutes: FastifyPluginAsyncZod = async (app) => {
  // onRequest, not preHandler: auth must come before validation (401 before 400).
  app.addHook("onRequest", requireUser);

  app.get(
    "/api/principals",
    { schema: { querystring: principalsQuerySchema, response: { 200: principalsResponseSchema } } },
    async (req) => {
      const refs = req.query.refs?.flatMap((r) => normaliseRef(r) ?? []);
      const principals =
        refs && !refs.length
          ? []
          : await loadPrincipalItems(
              app.db,
              app.templates.dir,
              refs ? inArray(schema.principals.ref, refs) : undefined,
            );
      return { principals };
    },
  );
};
