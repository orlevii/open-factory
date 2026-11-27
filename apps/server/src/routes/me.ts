import { schema } from "@open-factory/db";
import { meSchema, patchMeBodySchema } from "@open-factory/shared";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { requireUser } from "../auth/require-user.ts";
import { FieldError } from "../errors.ts";
import { FIELD_MSG } from "../field-messages.ts";
import { isHandleTaken } from "../principals/principal-store.ts";

export const meRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/api/me",
    { onRequest: requireUser, schema: { response: { 200: meSchema } } },
    async (req) => {
      if (!req.user) throw new Error("requireUser did not set request.user");
      return req.user;
    },
  );

  // The person's own name (users.name) and handle (principals.handle), written together or not at all.
  app.patch(
    "/api/me",
    { onRequest: requireUser, schema: { body: patchMeBodySchema, response: { 200: meSchema } } },
    async (req) => {
      if (!req.user) throw new Error("requireUser did not set request.user");
      const { id } = req.user;
      const { name, handle } = req.body;
      try {
        await app.db.transaction(async (tx) => {
          if (name !== undefined)
            await tx.update(schema.users).set({ name }).where(eq(schema.users.id, id));
          if (handle !== undefined)
            await tx.update(schema.principals).set({ handle }).where(eq(schema.principals.id, id));
        });
      } catch (err) {
        if (isHandleTaken(err))
          throw new FieldError("handle", FIELD_MSG.handleTaken, "handle_taken");
        throw err;
      }
      if (name !== undefined || handle !== undefined) await app.publishPrincipal(id);
      return {
        ...req.user,
        ...(name !== undefined ? { name } : {}),
        ...(handle !== undefined ? { handle } : {}),
      };
    },
  );
};
