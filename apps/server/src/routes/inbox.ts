import {
  inboxItemResponseSchema,
  inboxPageSchema,
  readAllBodySchema,
  readAllResponseSchema,
  readFromBodySchema,
  readFromResponseSchema,
  undoReadAllBodySchema,
  undoReadAllResponseSchema,
  unreadCountSchema,
} from "@open-factory/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { InvalidCursorError } from "../agents/errors.ts";
import { requireUser } from "../auth/require-user.ts";
import { ApiError, FieldError } from "../errors.ts";
import { FIELD_MSG } from "../field-messages.ts";
import { NO_AGENT_AT_REF, refParams } from "./ref-params.ts";

const inboxQuerySchema = z.object({
  before: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Home's panel: `?unread=true&limit=5`. */
  unread: z.enum(["true", "false"]).optional(),
  /** The notifier's query: with `unread`, the items that notify, up to 200 whatever `limit` says. */
  notify: z.enum(["true", "false"]).optional(),
});

/** Spec §11: the caller's inbox, newest first. Human session only: an agent token gets 401 like no auth. */
export const inboxRoutes: FastifyPluginAsyncZod = async (app) => {
  // onRequest: auth before validation (401 before 400).
  app.addHook("onRequest", requireUser);
  const userOf = (req: { user?: { id: string } }) => {
    if (!req.user) throw new Error("requireUser did not set request.user");
    return req.user.id;
  };

  app.get(
    "/api/inbox",
    { schema: { querystring: inboxQuerySchema, response: { 200: inboxPageSchema } } },
    async (req) => {
      try {
        const notify = req.query.notify === "true";
        const page = await app.store.inboxPage(
          userOf(req),
          req.query.before,
          notify ? 200 : req.query.limit,
          { unread: req.query.unread === "true", notify },
        );
        // The chat rows carry their agent's summary fields (I1 §6.7). The response schema validates and serializes it.
        const { chats: unread, updates: unreadUpdates, ...rest } = page;
        const withAgent = (rows: typeof unread) =>
          Promise.all(
            (rows ?? []).map(async ({ ref, ...row }) => {
              const a = await app.agents.summary(ref);
              return {
                ...row,
                agent: {
                  ref: a.ref,
                  handle: a.handle,
                  displayName: a.displayName,
                  template: a.template,
                  avatarVersion: a.avatarVersion,
                  color: a.color,
                  kind: a.kind,
                  status: a.status,
                  archivedAt: a.archivedAt,
                },
              };
            }),
          );
        if (!unread) return rest;
        const [chats, updates] = await Promise.all([withAgent(unread), withAgent(unreadUpdates)]);
        return { ...rest, chats, updates };
      } catch (err) {
        if (err instanceof InvalidCursorError) throw new FieldError("before", err.message);
        throw err;
      }
    },
  );

  app.get(
    "/api/inbox/unread-count",
    { schema: { response: { 200: unreadCountSchema } } },
    async (req) => {
      const u = userOf(req);
      const [count, byAgent] = await Promise.all([
        app.store.unreadCount(u),
        app.store.unreadByAgent(u),
      ]);
      return { count, byAgent };
    },
  );

  // Read state is per user (one row per user per item): a change reaches that user's sockets only.
  app.post(
    "/api/inbox/read-all",
    { schema: { body: readAllBodySchema, response: { 200: readAllResponseSchema } } },
    async (req) => {
      const userId = userOf(req);
      try {
        const r = await app.store.markAllRead(userId, req.body.upTo);
        if (r.count) app.bus.publishToUser(userId, { type: "inbox_changed" });
        return r;
      } catch (err) {
        if (err instanceof InvalidCursorError) throw new FieldError("upTo", FIELD_MSG.invalidTime);
        throw err;
      }
    },
  );

  app.post(
    "/api/inbox/read-from/:ref",
    {
      schema: {
        params: refParams,
        body: readFromBodySchema,
        response: { 200: readFromResponseSchema },
      },
    },
    async (req) => {
      const userId = userOf(req);
      try {
        const r = await app.store.markReadFrom(
          userId,
          req.params.ref,
          req.body.upTo,
          req.body.kind,
        );
        if (!r) throw new ApiError(404, "agent_not_found", NO_AGENT_AT_REF);
        if (r.marked) app.bus.publishToUser(userId, { type: "inbox_changed" });
        return r;
      } catch (err) {
        if (err instanceof InvalidCursorError) throw new FieldError("upTo", FIELD_MSG.invalidTime);
        throw err;
      }
    },
  );

  app.post(
    "/api/inbox/read-all/undo",
    { schema: { body: undoReadAllBodySchema, response: { 200: undoReadAllResponseSchema } } },
    async (req) => {
      const userId = userOf(req);
      try {
        const r = await app.store.undoReadAll(userId, req.body.readAt);
        if (r.count) app.bus.publishToUser(userId, { type: "inbox_changed" });
        return r;
      } catch (err) {
        if (err instanceof InvalidCursorError)
          throw new FieldError("readAt", FIELD_MSG.invalidTime);
        throw err;
      }
    },
  );

  app.post(
    "/api/inbox/:id/read",
    {
      schema: {
        params: z.object({ id: z.string().min(1).max(64) }),
        response: { 200: z.object({ ok: z.literal(true) }) },
      },
    },
    async (req) => {
      const userId = userOf(req);
      // Scoped by user: someone else's item is simply not found.
      if (!(await app.store.markRead(userId, req.params.id)))
        throw new ApiError(404, "inbox_item_not_found", "No such inbox item");
      app.bus.publishToUser(userId, { type: "inbox_changed" });
      return { ok: true as const };
    },
  );

  // Registered after the static segments (unread-count): the router prefers them anyway.
  app.get(
    "/api/inbox/:id",
    {
      schema: {
        params: z.object({ id: z.string().min(1).max(64) }),
        response: { 200: inboxItemResponseSchema },
      },
    },
    async (req) => {
      // Scoped by user: someone else's item is simply not found.
      const item = await app.store.inboxItem(userOf(req), req.params.id);
      if (!item) throw new ApiError(404, "inbox_item_not_found", "No such inbox item");
      return { item };
    },
  );
};
