import os from "node:os";
import { hostInfoSchema } from "@open-factory/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { requireUser } from "../auth/require-user.ts";

/** Facts about the factory's machine for path help (I6). Authenticated: hostname and home aren't public. */
export const hostRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("onRequest", requireUser);
  app.get("/api/host", { schema: { response: { 200: hostInfoSchema } } }, async () => ({
    platform: process.platform,
    hostname: os.hostname(),
    home: os.homedir(),
  }));
};
