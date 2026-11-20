import path from "node:path";
import {
  createTemplateBodySchema,
  issuesResponseSchema,
  nameSchema,
  putTemplateFileBodySchema,
  putTemplateFileResponseSchema,
  templateDetailResponseSchema,
  templateFileSchema,
  templatesListSchema,
  validateTemplateBodySchema,
} from "@open-factory/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireUser } from "../auth/require-user.ts";
import { templateImageStatus } from "../images/status.ts";
import type { DockerClient } from "../runtime/docker/client.ts";

const params = z.object({ name: nameSchema });
const fileParams = z.object({ name: nameSchema, file: templateFileSchema });

export const templatesRoutes: FastifyPluginAsyncZod<{ docker: DockerClient }> = async (
  app,
  { docker },
) => {
  const imageDeps = () => ({
    docker,
    builder: app.images,
    imagesRoot: path.join(app.config.factoryHome, "images"),
  });
  // onRequest, not preHandler: auth must come before validation (401 before 400).
  app.addHook("onRequest", requireUser);

  app.get("/api/templates", { schema: { response: { 200: templatesListSchema } } }, async () => {
    const rows = await app.templates.scan();
    const byTemplate = await app.templates.agentCounts();
    return {
      dir: app.templates.dir,
      templates: await Promise.all(
        rows.map(async (r) => {
          const imageStatus = await templateImageStatus(
            imageDeps(),
            r.config ?? undefined,
            app.config.defaultImage,
          );
          return {
            name: r.name,
            ...(r.config
              ? {
                  displayName: r.config.displayName,
                  description: r.config.description,
                  runtime: r.config.runtime,
                }
              : {}),
            errors: r.issues.filter((i) => i.severity === "error").length,
            warnings: r.issues.filter((i) => i.severity === "warning").length,
            agentCount: byTemplate.get(r.name) ?? 0,
            ...(imageStatus ? { imageStatus } : {}),
          };
        }),
      ),
    };
  });

  app.get(
    "/api/templates/:name",
    { schema: { params, response: { 200: templateDetailResponseSchema } } },
    async (req) => {
      const template = await app.templates.detail(req.params.name);
      const imageStatus = await templateImageStatus(
        imageDeps(),
        template.config ?? undefined,
        app.config.defaultImage,
      );
      return { template: { ...template, ...(imageStatus ? { imageStatus } : {}) } };
    },
  );

  app.post(
    "/api/templates",
    { schema: { body: createTemplateBodySchema, response: { 201: templateDetailResponseSchema } } },
    async (req, reply) => {
      await app.templates.create(req.body);
      return reply.code(201).send({ template: await app.templates.detail(req.body.name) });
    },
  );

  app.put(
    "/api/templates/:name/files/:file",
    {
      schema: {
        params: fileParams,
        body: putTemplateFileBodySchema,
        response: { 200: putTemplateFileResponseSchema },
      },
    },
    async (req) =>
      app.templates.writeFile(
        req.params.name,
        req.params.file,
        req.body.content,
        req.body.baseHash,
      ),
  );

  app.post(
    "/api/templates/:name/validate",
    {
      schema: { params, body: validateTemplateBodySchema, response: { 200: issuesResponseSchema } },
    },
    async (req) => ({
      issues: await app.templates.validate(req.params.name, req.body.file, req.body.content),
    }),
  );

  app.delete("/api/templates/:name", { schema: { params } }, async (req, reply) => {
    await app.templates.remove(req.params.name);
    return reply.code(204).send();
  });
};
