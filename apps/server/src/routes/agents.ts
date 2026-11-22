import {
  agentCommandsResponseSchema,
  agentDetailSchema,
  agentListQuerySchema,
  agentListSchema,
  agentResponseSchema,
  agentUsageSchema,
  commandText,
  compactBodySchema,
  createAgentBodySchema,
  eventsPageSchema,
  eventsQuerySchema,
  MAX_BODY_BYTES,
  MAX_FOCUS_CHARS,
  patchAgentBodySchema,
  queueItemResponseSchema,
  resyncResponseSchema,
  runCommandBodySchema,
  sendMessageBodySchema,
  slugSchema,
  stopCronsResponseSchema,
} from "@open-factory/shared";
import type { FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AgentRuntime } from "../agents/agent-runtime.ts";
import { commandsResponse, findCommand } from "../agents/commands.ts";
import {
  AgentArchivedError,
  AgentStartError,
  AgentTerminatedError,
  CompactingError,
  NoOpenTurnError,
  RecoveryRefusedError,
} from "../agents/errors.ts";
import {
  AgentEndedError,
  AlreadyDeliveredError,
  NotSenderError,
} from "../agents/message-cancel.ts";
import { requireUser } from "../auth/require-user.ts";
import { localRuntimeAllowed } from "../config.ts";
import { parseDays } from "./usage.ts";

const slugParams = z.object({ slug: slugSchema });
const queueItemParams = z.object({ slug: slugSchema, messageId: z.string().min(1) });
const err = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.code(status).send({ error: { code, message } });
const utf8 = new TextEncoder();

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
      ...(await app.agents.list(req.query.ended)),
      running: app.runtimes.supervisor.running(),
    }),
  );

  app.get(
    "/api/agents/:slug/usage",
    { schema: { params: slugParams, response: { 200: agentUsageSchema } } },
    async (req, reply) => {
      const u = await app.usage.agent(req.params.slug, parseDays(req.query));
      if (!u) return err(reply, 404, "agent_not_found", `No agent named ${req.params.slug}`);
      return u;
    },
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

  // U3 §13.3: the commands this agent may run (the allowed set the dispatch route enforces too).
  app.get(
    "/api/agents/:slug/commands",
    { schema: { params: slugParams, response: { 200: agentCommandsResponseSchema } } },
    async (req, reply) => {
      const row = await app.store.agentBySlug(req.params.slug);
      if (!row) return err(reply, 404, "agent_not_found", `No agent named ${req.params.slug}`);
      return commandsResponse(await app.store.agentCommands(row.id), row.config.skills);
    },
  );

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

  /** S7 §8: the one termination path, with the human as `by`. Idempotent: a terminated agent stays as it is. */
  app.post(
    "/api/agents/:slug/terminate",
    { schema: { params: slugParams, response: { 200: agentResponseSchema } } },
    async (req, reply) => {
      const row = await app.store.agentBySlug(req.params.slug);
      if (!row) return err(reply, 404, "agent_not_found", `No agent named ${req.params.slug}`);
      await app.terminator.terminate(row.id, `@${user(req).handle}`);
      return { agent: await app.agents.summary(row.slug) };
    },
  );

  /**
   * S7 §10.4: pin or unpin a terminated agent's workspace. Under the workspace lock the sweep's deletion takes, with the
   * row re-read under it: a pin that returned success always keeps the workspace.
   */
  const setPin =
    (pinned: boolean) => async (req: { params: { slug: string } }, reply: FastifyReply) => {
      const slug = req.params.slug;
      const outcome = await app.workspace.lock.run(slug, async () => {
        const row = await app.store.agentBySlug(slug);
        if (!row) return "not_found" as const;
        if (!row.terminatedAt) return "not_terminated" as const;
        if (row.workspaceDeletedAt) return "workspace_deleted" as const;
        await app.store.setWorkspacePinned(row.id, pinned);
        return "ok" as const;
      });
      if (outcome === "not_found")
        return err(reply, 404, "agent_not_found", `No agent named ${slug}`);
      if (outcome === "not_terminated")
        return err(
          reply,
          409,
          "not_terminated",
          "Only a terminated agent's workspace can be pinned.",
        );
      if (outcome === "workspace_deleted")
        return err(reply, 409, "workspace_deleted", "This agent's workspace was already deleted.");
      return { agent: await app.agents.summary(slug) };
    };
  const pinRoute = { schema: { params: slugParams, response: { 200: agentResponseSchema } } };
  app.put("/api/agents/:slug/workspace-pin", pinRoute, setPin(true));
  app.delete("/api/agents/:slug/workspace-pin", pinRoute, setPin(false));

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
          {
            ...(req.body.clientMessageId ? { clientMessageId: req.body.clientMessageId } : {}),
            ...(req.body.attachments?.length ? { attachments: req.body.attachments } : {}),
          },
        );
        if (!r.ok) {
          if (r.code === "invalid_attachment") return err(reply, 422, r.code, r.message);
          // The `[attached: …]` lines pushed the body over the limit the schema checks without them.
          if (r.code === "too_large") return err(reply, 400, "validation_error", r.message);
          if (r.code === "archived") {
            const e = new AgentArchivedError(req.params.slug);
            return err(reply, 409, "agent_archived", e.message);
          }
          if (r.code === "terminated") return err(reply, 409, "agent_terminated", r.message);
          return err(reply, 404, "agent_not_found", `No agent named ${req.params.slug}`);
        }
        return reply.code(202).send(queueItemResponseSchema.parse({ item: r.item }));
      } catch (e) {
        if (e instanceof AgentArchivedError) return err(reply, 409, "agent_archived", e.message);
        if (e instanceof AgentTerminatedError)
          return err(reply, 409, "agent_terminated", e.message);
        if (e instanceof AgentStartError) return err(reply, 503, "agent_start_failed", e.message);
        throw e;
      }
    },
  );

  /**
   * U3 §6.4: cancel a held message, and Undo it. The runtime checks the sender (403 `not_sender`) and that nothing
   * has written it (409 `already_delivered`); a restore to an ended agent is 409 `agent_ended`. Every attempt leaves
   * an audit line with the user, the agent and the message.
   */
  const queueRefusal = (
    e: unknown,
  ): [status: number, code: string, message: string] | undefined => {
    if (e instanceof NotSenderError) return [403, e.code, e.message];
    if (e instanceof AlreadyDeliveredError || e instanceof AgentEndedError)
      return [409, e.code, e.message];
    if (e instanceof AgentArchivedError) return [409, "agent_archived", e.message];
    if (e instanceof AgentTerminatedError) return [409, "agent_terminated", e.message];
    if (e instanceof AgentStartError) return [503, "agent_start_failed", e.message];
    return undefined;
  };
  /** The audit line (U3 §6.4): who, which agent, which message, and the refusal when there was one. */
  const queueAction = async <T>(
    action: "cancel" | "restore",
    req: { user?: { id: string; handle: string }; params: { slug: string; messageId: string } },
    reply: FastifyReply,
    run: (rt: AgentRuntime, userId: string) => Promise<T>,
  ) => {
    const rt = await app.runtimes.bySlug(req.params.slug);
    if (!rt) return err(reply, 404, "agent_not_found", `No agent named ${req.params.slug}`);
    const o = { user: user(req).id, agent: rt.agent.slug, messageId: req.params.messageId };
    try {
      const out = await run(rt, o.user);
      app.log.info(o, `queued message ${action}`);
      return out;
    } catch (e) {
      const refused = queueRefusal(e);
      if (!refused) throw e;
      app.log.info({ ...o, refused: refused[1] }, `queued message ${action} refused`);
      return err(reply, ...refused);
    }
  };

  app.delete(
    "/api/agents/:slug/queue/:messageId",
    { schema: { params: queueItemParams, response: { 200: queueItemResponseSchema } } },
    (req, reply) =>
      queueAction("cancel", req, reply, async (rt, userId) => ({
        item: await rt.cancelQueued(req.params.messageId, userId),
      })),
  );

  app.post(
    "/api/agents/:slug/queue/:messageId/restore",
    { schema: { params: queueItemParams } },
    (req, reply) =>
      queueAction("restore", req, reply, async (rt, userId) => {
        await rt.restoreQueued(req.params.messageId, userId);
        return reply.code(204).send();
      }),
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
        if (e instanceof AgentTerminatedError)
          return err(reply, 409, "agent_terminated", e.message);
        if (e instanceof AgentStartError) return err(reply, 503, "agent_start_failed", e.message);
        throw e;
      }
    },
  );

  /**
   * U3 §13.3 (dispatch): a human runs a slash command. Humans only: an agent has no session (the REST API never reads
   * agent tokens), and its `send_message` text is never a command. The name resolves against the same allowed set the
   * GET returns (422 `unknown_command` otherwise), and the raw text is built from the allowed entry's own name, never
   * the typed token. `compact` and `clear` take the server's own flows; everything else is held and written raw.
   */
  app.post(
    "/api/agents/:slug/commands",
    { schema: { params: slugParams, body: runCommandBodySchema } },
    async (req, reply) => {
      const u = user(req);
      const row = await app.store.agentBySlug(req.params.slug);
      const rt = row && (await app.runtimes.bySlug(req.params.slug));
      if (!row || !rt)
        return err(reply, 404, "agent_not_found", `No agent named ${req.params.slug}`);
      const { name, args, clientMessageId } = req.body;
      const allowed = commandsResponse(await app.store.agentCommands(row.id), row.config.skills);
      const entry = findCommand(allowed.commands, name);
      const audit = { user: u.id, agent: row.slug, command: entry?.name ?? null };
      if (!entry) {
        app.log.info({ ...audit, refused: "unknown_command" }, "command refused");
        return err(reply, 422, "unknown_command", `/${name} isn't a command this agent can run.`);
      }
      if (utf8.encode(commandText(entry.name, args)).length > MAX_BODY_BYTES)
        return err(reply, 413, "too_large", "The command is larger than 64 KB.");
      try {
        if (entry.name === "clear") {
          await rt.resetSession({ byHandle: u.handle });
          app.log.info(audit, "command run");
          return reply.code(202).send({});
        }
        if (entry.name === "compact" && args.length > MAX_FOCUS_CHARS)
          return err(
            reply,
            400,
            "validation_error",
            `The compact focus is longer than ${MAX_FOCUS_CHARS} characters.`,
          );
        const item =
          entry.name === "compact"
            ? await rt.compact({ ...(args ? { focus: args } : {}), byHandle: u.handle })
            : await rt.command({
                name: entry.name,
                args,
                userId: u.id,
                byHandle: u.handle,
                ...(clientMessageId ? { clientMessageId } : {}),
              });
        app.log.info(audit, "command queued");
        return reply.code(202).send(queueItemResponseSchema.parse({ item }));
      } catch (e) {
        if (e instanceof RecoveryRefusedError) return err(reply, 409, e.code, e.message);
        if (e instanceof AgentArchivedError) return err(reply, 409, "agent_archived", e.message);
        if (e instanceof AgentTerminatedError)
          return err(reply, 409, "agent_terminated", e.message);
        if (e instanceof AgentStartError) return err(reply, 503, "agent_start_failed", e.message);
        throw e;
      }
    },
  );

  /** Restart and Start a new session share their refusals (spec §9.7). */
  const recoveryError = (reply: FastifyReply, e: unknown) => {
    if (e instanceof RecoveryRefusedError) return err(reply, 409, e.code, e.message);
    if (e instanceof AgentArchivedError) return err(reply, 409, "agent_archived", e.message);
    if (e instanceof AgentTerminatedError) return err(reply, 409, "agent_terminated", e.message);
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

  // S9 §10.3: a human stops the agent's in-session crons (its process hibernates, with the passive notice waiting).
  app.post(
    "/api/agents/:slug/stop-crons",
    { schema: { params: slugParams, response: { 200: stopCronsResponseSchema } } },
    async (req, reply) => {
      const rt = await app.runtimes.bySlug(req.params.slug);
      if (!rt) return err(reply, 404, "agent_not_found", `No agent named ${req.params.slug}`);
      try {
        return await rt.stopCrons(user(req).handle);
      } catch (e) {
        return recoveryError(reply, e);
      }
    },
  );

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
        if (e instanceof AgentTerminatedError)
          return err(reply, 409, "agent_terminated", e.message);
        if (e instanceof NoOpenTurnError)
          return err(reply, 409, "no_open_turn", "Nothing to interrupt");
        if (e instanceof CompactingError) return err(reply, 409, "compacting", e.message);
        throw e;
      }
    },
  );
};
