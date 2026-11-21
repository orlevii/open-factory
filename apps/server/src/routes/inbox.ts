import {
  inboxPageSchema,
  readAllBodySchema,
  readAllResponseSchema,
  undoReadAllBodySchema,
  undoReadAllResponseSchema,
  unreadCountSchema,
} from "@open-factory/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { InvalidCursorError } from "../agents/errors.ts";
import { requireUser } from "../auth/require-user.ts";
import { ApiError, FieldError } from "../errors.ts";

const inboxQuerySchema = z.object({
  before: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Home's panel: `?unread=true&limit=5`. */
  unread: z.enum(["true", "false"]).optional(),
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
        // The response schema validates and serializes it (no second parse here).
        return await app.store.inboxPage(userOf(req), req.query.before, req.query.limit, {
          unread: req.query.unread === "true",
        });
      } catch (err) {
        if (err instanceof InvalidCursorError) throw new FieldError("before", err.message);
        throw err;
      }
    },
  );

  app.get(
    "/api/inbox/unread-count",
    { schema: { response: { 200: unreadCountSchema } } },
    async (req) => ({ count: await app.store.unreadCount(userOf(req)), byAgent: {} }),
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
        if (err instanceof InvalidCursorError) throw new FieldError("upTo", "Not a valid time.");
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
        if (err instanceof InvalidCursorError) throw new FieldError("readAt", "Not a valid time.");
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
};
