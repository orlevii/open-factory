import {
  putSecretBodySchema,
  secretParamsSchema,
  secretSummarySchema,
  secretsListSchema,
} from "@open-factory/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireUser } from "../auth/require-user.ts";

export const secretsRoutes: FastifyPluginAsyncZod = async (app) => {
  // onRequest, not preHandler: auth must come before validation (401 before 400).
  app.addHook("onRequest", requireUser);

  app.get("/api/secrets", { schema: { response: { 200: secretsListSchema } } }, async () => ({
    secrets: await app.secrets.list(),
  }));

  app.put(
    "/api/secrets/:name",
    {
      schema: {
        params: secretParamsSchema,
        body: putSecretBodySchema,
        response: { 200: z.object({ secret: secretSummarySchema }) },
      },
    },
    async (req) => ({ secret: await app.secrets.put(req.params.name, req.body.value) }),
  );

  app.delete(
    "/api/secrets/:name",
    { schema: { params: secretParamsSchema } },
    async (req, reply) => {
      await app.secrets.remove(req.params.name);
      return reply.code(204).send();
    },
  );
};
