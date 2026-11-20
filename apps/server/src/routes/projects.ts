import {
  createProjectBodySchema,
  nameSchema,
  patchProjectBodySchema,
  projectResponseSchema,
  projectsListSchema,
} from "@open-factory/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireUser } from "../auth/require-user.ts";

const params = z.object({ name: nameSchema });

export const projectsRoutes: FastifyPluginAsyncZod = async (app) => {
  // onRequest, not preHandler: auth must come before validation (401 before 400).
  app.addHook("onRequest", requireUser);

  app.get("/api/projects", { schema: { response: { 200: projectsListSchema } } }, async () => ({
    projects: await app.projects.list(),
  }));

  app.post(
    "/api/projects",
    { schema: { body: createProjectBodySchema, response: { 201: projectResponseSchema } } },
    async (req, reply) => reply.code(201).send({ project: await app.projects.create(req.body) }),
  );

  app.patch(
    "/api/projects/:name",
    {
      schema: {
        params,
        body: patchProjectBodySchema,
        response: { 200: projectResponseSchema },
      },
    },
    async (req) => ({ project: await app.projects.update(req.params.name, req.body.hostPath) }),
  );

  app.delete("/api/projects/:name", { schema: { params } }, async (req, reply) => {
    await app.projects.remove(req.params.name);
    return reply.code(204).send();
  });
};
