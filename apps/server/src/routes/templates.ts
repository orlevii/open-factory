import path from "node:path";
import {
  createTemplateBodySchema,
  effectivePlugins,
  issuesResponseSchema,
  nameSchema,
  putTemplateConfigBodySchema,
  putTemplateConfigResponseSchema,
  putTemplateFileBodySchema,
  putTemplateFileResponseSchema,
  templateConfigResponseSchema,
  templateDetailResponseSchema,
  templateFileSchema,
  templatesListSchema,
  validateTemplateBodySchema,
} from "@open-factory/shared";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireUser } from "../auth/require-user.ts";
import { ApiError } from "../errors.ts";
import { statusMemo, templateImageStatus } from "../images/status.ts";
import type { DockerClient } from "../runtime/docker/client.ts";
import { readAvatar } from "../templates/avatar.ts";

const params = z.object({ name: nameSchema });
const fileParams = z.object({ name: nameSchema, file: templateFileSchema });

export const templatesRoutes: FastifyPluginAsyncZod<{ docker: DockerClient }> = async (
  app,
  { docker },
) => {
  /** Per request: each image's status is computed once and shared by the templates that use it. */
  const imageDeps = (req: FastifyRequest) => ({
    docker,
    builder: app.images,
    imagesRoot: path.join(app.config.factoryHome, "images"),
    log: req.log,
    memo: statusMemo(),
  });
  // onRequest, not preHandler: auth must come before validation (401 before 400).
  app.addHook("onRequest", requireUser);
  const handleOf = (req: FastifyRequest) => {
    if (!req.user) throw new Error("requireUser did not set request.user");
    return req.user.handle;
  };

  app.get("/api/templates", { schema: { response: { 200: templatesListSchema } } }, async (req) => {
    const rows = await app.templates.scan();
    const byTemplate = await app.templates.agentCounts();
    const deps = imageDeps(req);
    return {
      dir: app.templates.dir,
      templates: await Promise.all(
        rows.map(async (r) => {
          const imageStatus = await templateImageStatus(
            deps,
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
            pluginCount: r.lastValid ? effectivePlugins(r.lastValid).length : 0,
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
        imageDeps(req),
        template.config ?? undefined,
        app.config.defaultImage,
      );
      return { template: { ...template, ...(imageStatus ? { imageStatus } : {}) } };
    },
  );

  /**
   * U2 §15.3: the template's `avatar.svg`, served from the handle the symlink checks ran on (`readAvatar`). The path
   * comes from the index entry, never the URL; anything absent, rejected or over 256 KB is 404. The SVG is locked down:
   * no sniffing, and a CSP that forbids scripts and fetches and sandboxes it even when opened directly.
   */
  app.get("/api/templates/:name/avatar.svg", { schema: { params } }, async (req, reply) => {
    const row = await app.templates.scanOne(req.params.name);
    const avatar = row ? await readAvatar(row.path, app.templates.dir) : null;
    if (!avatar) throw new ApiError(404, "avatar_not_found", "This template has no avatar.");
    return reply
      .header("Content-Type", "image/svg+xml")
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .header("Cache-Control", "private, max-age=31536000, immutable")
      .header("ETag", `"${avatar.version}"`)
      .send(avatar.body);
  });

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
        `@${handleOf(req)}`,
      ),
  );

  app.get(
    "/api/templates/:name/config",
    { schema: { params, response: { 200: templateConfigResponseSchema } } },
    async (req) => app.templates.readConfig(req.params.name),
  );

  app.put(
    "/api/templates/:name/config",
    {
      schema: {
        params,
        body: putTemplateConfigBodySchema,
        response: { 200: putTemplateConfigResponseSchema },
      },
    },
    async (req) => {
      const { changed, ...saved } = await app.templates.writeConfig(
        req.params.name,
        req.body.doc,
        req.body.baseHashes,
        `@${handleOf(req)}`,
      );
      // At once, so an open template or agent page refreshes without waiting for the change flow (spec §7.1).
      if (changed) app.bus.publishAll({ type: "config_changed", template: req.params.name });
      return saved;
    },
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
