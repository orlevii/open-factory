import {
  marketplaceAddBodySchema,
  marketplaceDetailSchema,
  marketplaceFetchBodySchema,
  marketplaceFetchedSchema,
  marketplaceNameParamsSchema,
  marketplacePreviewBodySchema,
  marketplacePreviewSchema,
  marketplacesResponseSchema,
  marketplaceUpdateBodySchema,
  marketplaceViewSchema,
  pluginDetailSchema,
  pluginDiffBodySchema,
  pluginDiffSchema,
  pluginFileQuerySchema,
  pluginFileTextSchema,
  pluginKeyParamsSchema,
  pluginReadBodySchema,
  pluginReadQuerySchema,
  pluginsResponseSchema,
  skillDetailSchema,
  skillFileQuerySchema,
  skillFileTextSchema,
  skillGroupsResponseSchema,
  skillNamesBodySchema,
  skillSourceAddBodySchema,
  skillSourcePreviewBodySchema,
  sourceDetailSchema,
  sourcePreviewSchema,
  sourceRemovedSchema,
  sourceUpdateBodySchema,
  sourceViewSchema,
} from "@open-factory/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireUser } from "../auth/require-user.ts";
import { ApiError } from "../errors.ts";
import { GitError } from "../library/git.ts";

const skillParams = z.object({ group: z.string().min(1), name: z.string().min(1) });
const idParams = z.object({ id: z.string().min(1) });

/**
 * The Library (spec §9): skills, plugins and their sources. Humans only: `requireUser` takes a session, never an agent
 * token, and the factory MCP server registers no Library tool (spec §11.1). The sources and marketplaces
 * services publish `library_changed` after every write.
 */
export const libraryRoutes: FastifyPluginAsyncZod = async (app) => {
  // onRequest, not preHandler: auth must come before validation (401 before 400).
  app.addHook("onRequest", requireUser);
  const by = (req: { user?: { handle: string } }) => {
    if (!req.user) throw new Error("requireUser did not set request.user");
    return req.user.handle;
  };

  // Reads (§9.1).

  app.get(
    "/api/library/skills",
    { schema: { response: { 200: skillGroupsResponseSchema } } },
    async () => ({ hostDir: app.config.hostClaudeDir, groups: await app.library.skills() }),
  );

  app.get(
    "/api/library/skills/:group/:name",
    { schema: { params: skillParams, response: { 200: skillDetailSchema } } },
    async (req) => app.library.detail(req.params.group, req.params.name),
  );

  app.get(
    "/api/library/skills/:group/:name/file",
    {
      schema: {
        params: skillParams,
        querystring: skillFileQuerySchema,
        response: { 200: skillFileTextSchema },
      },
    },
    async (req) => ({
      path: req.query.path,
      text: await app.library.fileText(req.params.group, req.params.name, req.query.path),
    }),
  );

  app.get(
    "/api/library/sources/:id",
    { schema: { params: idParams, response: { 200: sourceViewSchema } } },
    async (req) => {
      const detail = await app.skillSources.detailOf(req.params.id);
      if (!detail.updateCommit) return { ...detail, update: null };
      // A view that can't be built (the new commit can't be fetched or checked out) leaves the peek without its
      // changes, not without the source. Anything else is a bug and surfaces as a 500.
      const update = await app.skillSources.updateView(req.params.id).catch((e: unknown) => {
        if (!(e instanceof GitError || e instanceof ApiError)) throw e;
        req.log.warn({ err: e }, "building the update view failed");
        return null;
      });
      return { ...detail, update };
    },
  );

  // Skill sources (§9.2).

  app.post(
    "/api/library/sources/preview",
    { schema: { body: skillSourcePreviewBodySchema, response: { 200: sourcePreviewSchema } } },
    async (req) => app.skillSources.preview(req.body, by(req)),
  );

  app.post(
    "/api/library/sources",
    {
      schema: {
        body: skillSourceAddBodySchema,
        response: { 201: sourceDetailSchema, 202: sourceDetailSchema },
      },
    },
    async (req, reply) => {
      const { status, source } = await app.skillSources.add(req.body, by(req));
      return reply.code(status).send(source);
    },
  );

  app.post(
    "/api/library/sources/:id/find",
    { schema: { params: idParams, response: { 200: sourcePreviewSchema } } },
    async (req) => app.skillSources.find(req.params.id),
  );

  app.post(
    "/api/library/sources/:id/add",
    {
      schema: {
        params: idParams,
        body: skillNamesBodySchema,
        response: { 200: sourceDetailSchema },
      },
    },
    async (req) => app.skillSources.addSkills(req.params.id, req.body.skills, by(req)),
  );

  app.post(
    "/api/library/sources/:id/check",
    { schema: { params: idParams, response: { 200: sourceDetailSchema } } },
    async (req) => app.skillSources.check(req.params.id),
  );

  app.post(
    "/api/library/sources/:id/update",
    {
      schema: {
        params: idParams,
        body: sourceUpdateBodySchema,
        response: { 200: sourceDetailSchema },
      },
    },
    async (req) => app.skillSources.update(req.params.id, req.body.commit, by(req)),
  );

  app.post(
    "/api/library/sources/:id/fetch",
    { schema: { params: idParams, response: { 200: sourceDetailSchema } } },
    async (req) => app.skillSources.refetch(req.params.id),
  );

  app.post(
    "/api/library/check",
    { schema: { response: { 202: z.object({}) } } },
    async (_req, reply) => {
      // Progress arrives as `library_changed` frames, one per checked source or marketplace (§9.2).
      await app.skillSources.startCheckAll();
      await app.marketplaces.startCheckAll();
      return reply.code(202).send({});
    },
  );

  // Removal and Undo (§9.4).

  app.delete(
    "/api/library/sources/:id",
    { schema: { params: idParams, response: { 200: sourceRemovedSchema } } },
    async (req) => app.skillSources.remove(req.params.id),
  );

  app.post(
    "/api/library/sources/:id/restore",
    { schema: { params: idParams, response: { 200: sourceDetailSchema } } },
    async (req) => app.skillSources.restore(req.params.id, by(req)),
  );

  // Plugins (§9.1).

  app.get(
    "/api/library/plugins",
    { schema: { response: { 200: pluginsResponseSchema } } },
    async () => app.plugins.list(),
  );

  app.get(
    "/api/library/plugins/:key",
    {
      schema: {
        params: pluginKeyParamsSchema,
        querystring: pluginReadQuerySchema,
        response: { 200: pluginDetailSchema },
      },
    },
    async (req) => app.plugins.detail(req.params.key, req.query),
  );

  app.get(
    "/api/library/plugins/:key/file",
    {
      schema: {
        params: pluginKeyParamsSchema,
        querystring: pluginFileQuerySchema,
        response: { 200: pluginFileTextSchema },
      },
    },
    async (req) => {
      const { path, ...from } = req.query;
      return { path, text: await app.plugins.fileText(req.params.key, path, from) };
    },
  );

  app.get(
    "/api/library/marketplaces",
    { schema: { response: { 200: marketplacesResponseSchema } } },
    async () => app.plugins.marketplaces(),
  );

  app.get(
    "/api/library/marketplaces/:name",
    { schema: { params: marketplaceNameParamsSchema, response: { 200: marketplaceViewSchema } } },
    async (req) => {
      const detail = await app.marketplaces.detailOf(req.params.name);
      if (!detail.updateCommit) return { ...detail, update: null };
      // As for a source: a view that can't be built leaves the peek without its changes, not without the marketplace.
      const update = await app.marketplaces.updateView(req.params.name).catch((e: unknown) => {
        if (!(e instanceof GitError || e instanceof ApiError)) throw e;
        req.log.warn({ err: e }, "building the marketplace update view failed");
        return null;
      });
      return { ...detail, update };
    },
  );

  // Marketplaces and plugins that fetch (§9.3).

  app.post(
    "/api/library/marketplaces/preview",
    { schema: { body: marketplacePreviewBodySchema, response: { 200: marketplacePreviewSchema } } },
    async (req) => app.marketplaces.preview(req.body),
  );

  app.post(
    "/api/library/marketplaces",
    {
      schema: {
        body: marketplaceAddBodySchema,
        response: { 201: marketplaceDetailSchema, 202: marketplaceDetailSchema },
      },
    },
    async (req, reply) => {
      const { status, marketplace } = await app.marketplaces.add(req.body.previewId, by(req));
      return reply.code(status).send(marketplace);
    },
  );

  app.post(
    "/api/library/marketplaces/:name/check",
    { schema: { params: marketplaceNameParamsSchema, response: { 200: marketplaceDetailSchema } } },
    async (req) => app.marketplaces.check(req.params.name),
  );

  app.post(
    "/api/library/marketplaces/:name/update",
    {
      schema: {
        params: marketplaceNameParamsSchema,
        body: marketplaceUpdateBodySchema,
        response: { 200: marketplaceDetailSchema },
      },
    },
    async (req) => app.marketplaces.update(req.params.name, req.body.commit, by(req)),
  );

  app.post(
    "/api/library/marketplaces/:name/fetch",
    {
      schema: {
        params: marketplaceNameParamsSchema,
        body: marketplaceFetchBodySchema,
        response: { 200: marketplaceFetchedSchema },
      },
    },
    async (req) => app.marketplaces.fetchAt(req.params.name, req.body.ref),
  );

  app.post(
    "/api/library/plugins/:key/diff",
    {
      schema: {
        params: pluginKeyParamsSchema,
        body: pluginDiffBodySchema,
        response: { 200: pluginDiffSchema },
      },
    },
    async (req) => app.plugins.diff(req.params.key, req.body.from, req.body.to),
  );

  app.post(
    "/api/library/plugins/:key/read",
    {
      schema: {
        params: pluginKeyParamsSchema,
        body: pluginReadBodySchema,
        response: { 200: pluginDetailSchema },
      },
    },
    async (req) => app.plugins.read(req.params.key, req.body.commit),
  );

  app.post(
    "/api/library/host-plugins/:key/add-marketplace",
    {
      schema: {
        params: pluginKeyParamsSchema,
        response: { 201: marketplaceDetailSchema, 202: marketplaceDetailSchema },
      },
    },
    async (req, reply) => {
      const { status, marketplace } = await app.hostPlugins.addMarketplace(req.params.key, by(req));
      return reply.code(status).send(marketplace);
    },
  );

  // Removal and Undo of a marketplace (§9.4).

  app.delete(
    "/api/library/marketplaces/:name",
    { schema: { params: marketplaceNameParamsSchema, response: { 200: sourceRemovedSchema } } },
    async (req) => app.marketplaces.remove(req.params.name),
  );

  app.post(
    "/api/library/marketplaces/:name/restore",
    { schema: { params: marketplaceNameParamsSchema, response: { 200: marketplaceDetailSchema } } },
    async (req) => app.marketplaces.restore(req.params.name, by(req)),
  );
};
