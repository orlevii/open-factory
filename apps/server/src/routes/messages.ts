import {
  messageLookupSchema,
  normaliseRef,
  type SendMessagesResponse,
  sendMessagesBodySchema,
  sendMessagesResponseSchema,
} from "@open-factory/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireUser } from "../auth/require-user.ts";
import { ApiError, FieldError } from "../errors.ts";
import { principalsByRefs } from "../principals/principal-store.ts";
import { NO_AGENT_AT_REF } from "./ref-params.ts";

const idParams = z.object({ id: z.string().min(1) });

const MANY_WITH_FILES = "Files go to one agent at a time.";

/**
 * Spec §11: one message with the session events that show it on each side. Human session only, never on the agent
 * listener: an agent token gets 401 like no auth.
 */
export const messagesRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("onRequest", requireUser);

  app.get(
    "/api/messages/:id",
    { schema: { params: idParams, response: { 200: messageLookupSchema } } },
    async (req) => {
      const found = await app.store.messageLookup(req.params.id);
      if (!found) throw new ApiError(404, "message_not_found", "No such message");
      return found; // the response schema validates and serializes it
    },
  );

  /**
   * I1 §6.6: a human's message to one to ten agents. Each recipient succeeds or is refused alone, so the answer is 202
   * with one result per target; `start_failed` keeps that recipient's row pending. Attachments go to one agent only.
   */
  app.post(
    "/api/messages",
    {
      schema: {
        body: sendMessagesBodySchema,
        response: { 202: sendMessagesResponseSchema },
      },
    },
    async (req, reply) => {
      const { to, body, urgent, clientMessageId, attachments } = req.body;
      if (attachments?.length && to.length > 1)
        throw new ApiError(422, "invalid_attachment", MANY_WITH_FILES);
      // Spec §4.4: the recipients are refs. A handle, a tag or an unknown ref is the request's error, not a refusal.
      const refs = to.map((t) => normaliseRef(t));
      const known = await principalsByRefs(
        app.db,
        refs.filter((r) => r !== undefined),
      );
      if (refs.some((r) => r === undefined || !known.has(r)))
        throw new FieldError("to", NO_AGENT_AT_REF);
      const u = req.user as { id: string; handle: string };
      const { results } = await app.router.send(
        { userId: u.id, handle: u.handle },
        refs as string[],
        body,
        urgent,
        {
          ...(clientMessageId ? { clientMessageId } : {}),
          ...(attachments?.length ? { attachments } : {}),
        },
      );
      // An attachment problem or an over-long body (the `[attached: …]` lines count) is the request's, not a recipient's.
      for (const r of results) {
        if (r.status !== "refused") continue;
        if (r.code === "invalid_attachment") throw new ApiError(422, r.code, r.reason);
        if (r.code === "too_large") throw new ApiError(400, "validation_error", r.reason);
      }
      const out: SendMessagesResponse["results"] = results.map((r) => {
        if (r.status === "refused")
          return { to: r.to, status: "refused", reason: r.reason, code: r.code };
        if (r.status === "start_failed")
          return { to: r.to, status: "start_failed", id: r.id, reason: r.note };
        return {
          to: r.to,
          status: "queued",
          id: r.id,
          ...("item" in r && r.item ? { item: r.item } : {}),
        };
      });
      return reply.code(202).send({ results: out });
    },
  );
};
