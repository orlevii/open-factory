import {
  agentDetailSchema,
  agentListSchema,
  compactBodySchema,
  eventsPageSchema,
  eventsQuerySchema,
  queueItemResponseSchema,
  sendMessageBodySchema,
} from "@open-factory/shared";
import type { FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { AgentStartError, NoOpenTurnError } from "../agents/errors.ts";
import { requireUser } from "../auth/require-user.ts";

const slugParams = z.object({ slug: z.string() });
const err = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.code(status).send({ error: { code, message } });

export const agentsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", requireUser);

  const user = (req: { user?: { id: string; handle: string } }) => {
    if (!req.user) throw new Error("requireUser did not set request.user");
    return req.user;
  };

  app.get("/api/agents", { schema: { response: { 200: agentListSchema } } }, async () => ({
    agents: await app.runtimes.list(),
  }));

  app.get("/api/agents/:slug", { schema: { params: slugParams } }, async (req, reply) => {
    const rt = await app.runtimes.bySlug(req.params.slug);
    if (!rt) return err(reply, 404, "agent_not_found", `No agent named ${req.params.slug}`);
    return agentDetailSchema.parse({
      agent: rt.summary(),
      queue: rt.queueItems(),
      lastSeq: await app.store.lastSeq(rt.agent.id),
    });
  });

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
      const rt = await app.runtimes.bySlug(req.params.slug);
      if (!rt) return err(reply, 404, "agent_not_found", `No agent named ${req.params.slug}`);
      const u = user(req);
      try {
        const item = await rt.sendMessage({
          fromUserId: u.id,
          fromHandle: u.handle,
          body: req.body.body,
          urgent: req.body.urgent,
        });
        return reply.code(202).send(queueItemResponseSchema.parse({ item }));
      } catch (e) {
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
        if (e instanceof AgentStartError) return err(reply, 503, "agent_start_failed", e.message);
        throw e;
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
        if (e instanceof NoOpenTurnError)
          return err(reply, 409, "no_open_turn", "Nothing to interrupt");
        throw e;
      }
    },
  );
};
