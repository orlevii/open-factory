import { messageLookupSchema } from "@open-factory/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireUser } from "../auth/require-user.ts";
import { ApiError } from "../errors.ts";

const idParams = z.object({ id: z.string().min(1) });

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
};
