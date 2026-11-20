import {
  createCredentialBodySchema,
  credentialResponseSchema,
  credentialsListSchema,
  nameSchema,
  replaceCredentialValueBodySchema,
} from "@open-factory/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireUser } from "../auth/require-user.ts";

const params = z.object({ name: nameSchema });

export const credentialsRoutes: FastifyPluginAsyncZod = async (app) => {
  // onRequest, not preHandler: auth must come before validation (401 before 400).
  app.addHook("onRequest", requireUser);

  app.get(
    "/api/credentials",
    { schema: { response: { 200: credentialsListSchema } } },
    async () => ({ credentials: await app.credentials.list() }),
  );

  app.post(
    "/api/credentials",
    { schema: { body: createCredentialBodySchema, response: { 201: credentialResponseSchema } } },
    async (req, reply) =>
      reply.code(201).send({ credential: await app.credentials.create(req.body) }),
  );

  app.put(
    "/api/credentials/:name/value",
    {
      schema: {
        params,
        body: replaceCredentialValueBodySchema,
        response: { 200: credentialResponseSchema },
      },
    },
    async (req) => ({
      credential: await app.credentials.replace(req.params.name, req.body.value),
    }),
  );

  app.post(
    "/api/credentials/:name/verify",
    { schema: { params, response: { 200: credentialResponseSchema } } },
    async (req) => ({ credential: await app.credentials.reverify(req.params.name) }),
  );

  app.delete("/api/credentials/:name", { schema: { params } }, async (req, reply) => {
    await app.credentials.remove(req.params.name);
    return reply.code(204).send();
  });
};
