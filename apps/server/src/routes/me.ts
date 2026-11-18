import { meSchema } from "@open-factory/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { requireUser } from "../auth/require-user.ts";

export const meRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/api/me",
    { preHandler: requireUser, schema: { response: { 200: meSchema } } },
    async (req) => {
      if (!req.user) throw new Error("requireUser did not set request.user");
      return req.user;
    },
  );
};
