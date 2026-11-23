import { neutraliseEnvelopeTags } from "@open-factory/harness";
import {
  agentCommandsResponseSchema,
  agentDetailSchema,
  agentListQuerySchema,
  agentListSchema,
  agentResponseSchema,
  agentUsageSchema,
  chatPageSchema,
  chatQuerySchema,
  classifyInput,
  compactBodySchema,
  createAgentBodySchema,
  eventsPageSchema,
  eventsQuerySchema,
  inputBodySchema,
  MAX_BODY_BYTES,
  MAX_FOCUS_CHARS,
  patchAgentBodySchema,
  queueItemResponseSchema,
  resetPersonaResponseSchema,
  slugSchema,
  stopCronsResponseSchema,
} from "@open-factory/shared";
import type { FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AgentRuntime } from "../agents/agent-runtime.ts";
import { commandList, commandsResponse } from "../agents/commands.ts";
import {
  AgentArchivedError,
  AgentStartError,
  AgentTerminatedError,
  CommandsUnsupportedError,
  CompactingError,
  InvalidCursorError,
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
import { FieldError } from "../errors.ts";
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

  // I1 §6.3: this human's thread with the agent, with turn outcomes and the runtime's `working` fact.
  app.get(
    "/api/agents/:slug/chat",
    {
      schema: {
        params: slugParams,
        querystring: chatQuerySchema,
        response: { 200: chatPageSchema },
      },
    },
    async (req, reply) => {
      const rt = await app.runtimes.bySlug(req.params.slug);
      if (!rt) return err(reply, 404, "agent_not_found", `No agent named ${req.params.slug}`);
      const me = user(req);
      const { before, around, limit } = req.query;
      if (before !== undefined && around !== undefined)
        return err(reply, 400, "validation_error", "before and around can't be combined");
      // Read synchronously, before the query: a close that commits meanwhile has its outcome in the page or is
      // not yet visible to either read, never both missing (§6.3 read order).
      const working = rt.workingFor(me.id);
      // The runtime's row can be stale (archived since): a rejected row's reason reads the stored one.
      const row = (await app.store.agentBySlug(req.params.slug)) ?? rt.agent;
      let slice: Awaited<ReturnType<typeof app.chat.page>>;
      try {
        slice = await app.chat.page(
          {
            agent: {
              id: row.id,
              slug: row.slug,
              archivedAt: row.archivedAt,
              terminatedAt: row.terminatedAt,
            },
            user: { id: me.id, handle: me.handle },
          },
          {
            limit,
            ...(before !== undefined ? { before } : {}),
            ...(around !== undefined ? { around } : {}),
          },
        );
      } catch (e) {
        if (e instanceof InvalidCursorError) throw new FieldError("before", e.message);
        throw e;
      }
      if (!slice)
        return err(reply, 404, "message_not_found", `Message ${around} isn't in this chat`);
      const answered = slice.entries.some(
        (e) => e.kind === "turn_outcome" && e.key === working?.key,
      );
      return { ...slice, working: answered ? null : working };
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
      return commandsResponse(
        await app.store.agentCommands(row.id),
        await app.resolver.skillsOf(row, app.runtimes.startedOf(row.id)),
      );
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
    "/api/agents/:slug/reset-persona",
    { schema: { params: slugParams, response: { 200: resetPersonaResponseSchema } } },
    async (req) => app.agents.resetPersona(req.params.slug, `@${user(req).handle}`),
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
          userId: user(req).id,
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
   * I1 §5.1: a human types into the session. Humans only (the REST API never reads agent tokens). The text is a
   * command when its first token is a known name or on the denylist, free text otherwise; either way envelope tags
   * are neutralised and every other byte is as typed. `compact` takes the Compact flow, everything else is held and
   * written raw. Every outcome is audited with the kind and refusal code, never the text.
   */
  app.post(
    "/api/agents/:slug/input",
    { schema: { params: slugParams, body: inputBodySchema } },
    async (req, reply) => {
      const u = user(req);
      const row = await app.store.agentBySlug(req.params.slug);
      const rt = row && (await app.runtimes.bySlug(req.params.slug));
      if (!row || !rt)
        return err(reply, 404, "agent_not_found", `No agent named ${req.params.slug}`);
      const { clientMessageId } = req.body;
      const text = req.body.text.trimEnd();
      const audit = { user: u.id, agent: row.slug };
      const refuse = (kind: string, status: number, code: string, message: string) => {
        app.log.info({ ...audit, kind, refused: code }, "input refused");
        return err(reply, status, code, message);
      };
      if (!text) return refuse("text", 400, "validation_error", "Input is empty.");
      if (utf8.encode(text).length > MAX_BODY_BYTES)
        return refuse("text", 400, "validation_error", "Input is larger than 64 KB.");
      const known = new Set(
        commandList(
          (await app.store.agentCommands(row.id))?.commands,
          await app.resolver.skillsOf(row, rt.started),
        ).flatMap((c) => [c.name, ...(c.aliases ?? [])].map((n) => n.toLowerCase())),
      );
      const cls = classifyInput(text, known);
      if (cls.kind === "command") {
        if (cls.denied) return refuse("command", 422, "command_denied", cls.denied);
        if (cls.multiline)
          return refuse("command", 400, "validation_error", "A command must be one line.");
        if (cls.name === "compact" && cls.args.length > MAX_FOCUS_CHARS)
          return refuse(
            "command",
            400,
            "validation_error",
            `The compact focus is longer than ${MAX_FOCUS_CHARS} characters.`,
          );
      }
      const kind = cls.kind === "command" ? "command" : "text";
      try {
        const item =
          cls.kind === "command" && cls.name === "compact"
            ? await rt.compact({
                ...(cls.args.trim() ? { focus: cls.args.trim() } : {}),
                byHandle: u.handle,
                userId: u.id,
                clientMessageId,
              })
            : await rt.rawInput({
                text: neutraliseEnvelopeTags(cls.kind === "command" ? text.trimStart() : text),
                userId: u.id,
                by: `@${u.handle}`,
                clientMessageId,
              });
        app.log.info({ ...audit, kind: cls.kind === "command" ? cls.name : kind }, "input queued");
        return reply.code(202).send(queueItemResponseSchema.parse({ item }));
      } catch (e) {
        if (e instanceof CommandsUnsupportedError) return refuse(kind, 501, e.code, e.message);
        if (e instanceof AgentArchivedError) return refuse(kind, 409, "agent_archived", e.message);
        if (e instanceof AgentTerminatedError)
          return refuse(kind, 409, "agent_terminated", e.message);
        if (e instanceof AgentStartError) return refuse(kind, 503, "agent_start_failed", e.message);
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
