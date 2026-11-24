import {
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
import { hostSkillsDirOf } from "../config.ts";
import { ApiError } from "../errors.ts";
import { GitError } from "../library/git.ts";

const skillParams = z.object({ group: z.string().min(1), name: z.string().min(1) });
const idParams = z.object({ id: z.string().min(1) });

/**
 * The Library (spec §9): skills and their sources. Humans only: `requireUser` takes a session, never an agent
 * token, and the factory MCP server registers no Library tool (spec §11.1). The sources service publishes
 * `library_changed` after every write.
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
    async () => ({ hostDir: hostSkillsDirOf(app.config), groups: await app.library.skills() }),
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
      // Progress arrives as `library_changed` frames, one per checked source (§9.2).
      await app.skillSources.startCheckAll();
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
};
