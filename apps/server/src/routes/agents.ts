import {
  agentDetailSchema,
  agentListQuerySchema,
  agentListSchema,
  agentResponseSchema,
  compactBodySchema,
  createAgentBodySchema,
  eventsPageSchema,
  eventsQuerySchema,
  patchAgentBodySchema,
  queueItemResponseSchema,
  resyncResponseSchema,
  sendMessageBodySchema,
  slugSchema,
} from "@open-factory/shared";
import type { FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AgentArchivedError,
  AgentStartError,
  NoOpenTurnError,
  RecoveryRefusedError,
} from "../agents/errors.ts";
import { requireUser } from "../auth/require-user.ts";
import { localRuntimeAllowed } from "../config.ts";

const slugParams = z.object({ slug: slugSchema });
const err = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.code(status).send({ error: { code, message } });

export const agentsRoutes: FastifyPluginAsyncZod = async (app) => {
  // onRequest, not preHandler: Fastify validates before preHandler, so auth must come first (401 before 400).
  app.addHook("onRequest", requireUser);

  const user = (req: { user?: { id: string; handle: string } }) => {
    if (!req.user) throw new Error("requireUser did not set request.user");
    return req.user;
  };

  app.get(
    "/api/agents",
    { schema: { querystring: agentListQuerySchema, response: { 200: agentListSchema } } },
    async (req) => ({
      agents: await app.agents.list(req.query.ended),
      running: app.runtimes.supervisor.running(),
    }),
  );

  app.post(
    "/api/agents",
    { schema: { body: createAgentBodySchema, response: { 201: agentResponseSchema } } },
    async (req, reply) => reply.code(201).send({ agent: await app.agents.create(req.body) }),
  );

  app.get("/api/agents/:slug", { schema: { params: slugParams } }, async (req, reply) => {
    const rt = await app.runtimes.bySlug(req.params.slug);
    if (!rt) return err(reply, 404, "agent_not_found", `No agent named ${req.params.slug}`);
    return agentDetailSchema.parse({
      agent: await app.agents.summary(req.params.slug),
      queue: rt.queueItems(),
      lastSeq: await app.store.lastSeq(rt.agent.id),
    });
  });

  app.patch(
    "/api/agents/:slug",
    {
      schema: {
        params: slugParams,
        body: patchAgentBodySchema,
        response: { 200: agentResponseSchema },
      },
    },
    async (req) => ({ agent: await app.agents.update(req.params.slug, req.body) }),
  );

  app.post(
    "/api/agents/:slug/resync",
    { schema: { params: slugParams, response: { 200: resyncResponseSchema } } },
    async (req) => app.agents.resync(req.params.slug),
  );

  app.post(
    "/api/agents/:slug/archive",
    { schema: { params: slugParams, response: { 200: agentResponseSchema } } },
    async (req) => ({ agent: await app.agents.archive(req.params.slug) }),
  );

  app.post(
    "/api/agents/:slug/unarchive",
    { schema: { params: slugParams, response: { 200: agentResponseSchema } } },
    async (req) => ({ agent: await app.agents.unarchive(req.params.slug) }),
  );

  app.get(
    "/api/agents/:slug/events",
    { schema: { params: slugParams, querystring: eventsQuerySchema } },
    async (req, reply) => {
      const rt = await app.runtimes.bySlug(req.params.slug);
      if (!rt) return err(reply, 404, "agent_not_found", `No agent named ${req.params.slug}`);
      const { before, around, limit } = req.query;
      if (before !== undefined && around !== undefined) {
        return err(reply, 400, "validation_error", "before and around can't be combined");
      }
      // A cursor past the end behaves like no cursor: the newest page.
      const last = await app.store.lastSeq(rt.agent.id);
      const clamped = before !== undefined ? Math.min(before, last + 1) : undefined;
      const page = await app.store.page(rt.agent.id, {
        limit,
        ...(clamped !== undefined ? { before: clamped } : {}),
        ...(around !== undefined ? { around } : {}),
      });
      if (!page) return err(reply, 404, "event_not_found", `Event ${around} isn't in this session`);
      return eventsPageSchema.parse(page);
    },
  );

  app.post(
    "/api/agents/:slug/messages",
    { schema: { params: slugParams, body: sendMessageBodySchema } },
    async (req, reply) => {
      const u = user(req);
      try {
        // For a human sender the Router resolves agents only: a user, `humans` or a reserved name is not found.
        const r = await app.router.send(
          { userId: u.id, handle: u.handle },
          req.params.slug,
          req.body.body,
          req.body.urgent,
        );
        if (!r.ok) {
          if (r.code === "archived") {
            const e = new AgentArchivedError(req.params.slug);
            return err(reply, 409, "agent_archived", e.message);
          }
          return err(reply, 404, "agent_not_found", `No agent named ${req.params.slug}`);
        }
        return reply.code(202).send(queueItemResponseSchema.parse({ item: r.item }));
      } catch (e) {
        if (e instanceof AgentArchivedError) return err(reply, 409, "agent_archived", e.message);
        if (e instanceof AgentStartError) return err(reply, 503, "agent_start_failed", e.message);
        throw e;
      }
    },
  );

  app.post(
    "/api/agents/:slug/compact",
    { schema: { params: slugParams, body: compactBodySchema } },
    async (req, reply) => {
      const rt = await app.runtimes.bySlug(req.params.slug);
      if (!rt) return err(reply, 404, "agent_not_found", `No agent named ${req.params.slug}`);
      try {
        const item = await rt.compact({
          ...(req.body.focus ? { focus: req.body.focus } : {}),
          byHandle: user(req).handle,
        });
        return reply.code(202).send(queueItemResponseSchema.parse({ item }));
      } catch (e) {
        if (e instanceof AgentArchivedError) return err(reply, 409, "agent_archived", e.message);
        if (e instanceof AgentStartError) return err(reply, 503, "agent_start_failed", e.message);
        throw e;
      }
    },
  );

  /** Restart and Start a new session share their refusals (spec §9.7). */
  const recoveryError = (reply: FastifyReply, e: unknown) => {
    if (e instanceof RecoveryRefusedError) return err(reply, 409, e.code, e.message);
    if (e instanceof AgentArchivedError) return err(reply, 409, "agent_archived", e.message);
    if (e instanceof AgentStartError) return err(reply, 503, "agent_start_failed", e.message);
    throw e;
  };

  app.post("/api/agents/:slug/restart", { schema: { params: slugParams } }, async (req, reply) => {
    const rt = await app.runtimes.bySlug(req.params.slug);
    if (!rt) return err(reply, 404, "agent_not_found", `No agent named ${req.params.slug}`);
    try {
      await rt.restart({
        byHandle: user(req).handle,
        // A Restart certain to fail isn't offered (spec §13).
        runtimeAllowed: rt.agent.runtime !== "local" || localRuntimeAllowed(app.config),
      });
      return reply.code(202).send({});
    } catch (e) {
      return recoveryError(reply, e);
    }
  });

  app.post(
    "/api/agents/:slug/reset-session",
    { schema: { params: slugParams } },
    async (req, reply) => {
      const rt = await app.runtimes.bySlug(req.params.slug);
      if (!rt) return err(reply, 404, "agent_not_found", `No agent named ${req.params.slug}`);
      try {
        await rt.resetSession({ byHandle: user(req).handle });
        return reply.code(202).send({});
      } catch (e) {
        return recoveryError(reply, e);
      }
    },
  );

  app.post(
    "/api/agents/:slug/interrupt",
    { schema: { params: slugParams } },
    async (req, reply) => {
      const rt = await app.runtimes.bySlug(req.params.slug);
      if (!rt) return err(reply, 404, "agent_not_found", `No agent named ${req.params.slug}`);
      try {
        await rt.interrupt({ byHandle: user(req).handle });
        return reply.code(202).send({});
      } catch (e) {
        if (e instanceof AgentArchivedError) return err(reply, 409, "agent_archived", e.message);
        if (e instanceof NoOpenTurnError)
          return err(reply, 409, "no_open_turn", "Nothing to interrupt");
        throw e;
      }
    },
  );
};
