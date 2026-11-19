import type { AgentRow } from "@open-factory/db";
import type { AgentSummary } from "@open-factory/shared";
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
import { AgentArchivedError, AgentStartError, NoOpenTurnError } from "../agents/errors.ts";
import type { LiveFields } from "../agents/runtimes.ts";
import { requireUser } from "../auth/require-user.ts";

const slugParams = z.object({ slug: z.string() });
/**
 * Interim: the summary from the row plus the runtime's live fields. Task 14 replaces it with
 * AgentService.list()/summary() and deletes it.
 */
function summaryFromRow(row: AgentRow, live: LiveFields): AgentSummary {
  return {
    slug: row.slug,
    displayName: row.displayName,
    description: row.description,
    kind: "persistent",
    template: row.template,
    runtime: row.runtime,
    reportsTo: null,
    credential: "",
    projects: [],
    grantsOverridden: row.grantsOverridden,
    depth: 0,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    ...live,
  };
}
const err = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.code(status).send({ error: { code, message } });

export const agentsRoutes: FastifyPluginAsyncZod = async (app) => {
  // onRequest, not preHandler: Fastify validates before preHandler, so auth must come first (401 before 400).
  app.addHook("onRequest", requireUser);

  const user = (req: { user?: { id: string; handle: string } }) => {
    if (!req.user) throw new Error("requireUser did not set request.user");
    return req.user;
  };

  app.get("/api/agents", { schema: { response: { 200: agentListSchema } } }, async () => {
    const rows = await app.store.listAgents();
    return {
      agents: await Promise.all(
        rows.map(async (r) => summaryFromRow(r, await app.runtimes.liveFields(r.id, r))),
      ),
    };
  });

  app.get("/api/agents/:slug", { schema: { params: slugParams } }, async (req, reply) => {
    const rt = await app.runtimes.bySlug(req.params.slug);
    if (!rt) return err(reply, 404, "agent_not_found", `No agent named ${req.params.slug}`);
    return agentDetailSchema.parse({
      agent: summaryFromRow(rt.agent, rt.live()),
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
