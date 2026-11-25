import type { Db } from "@open-factory/db";
import { setupStatusSchema } from "@open-factory/shared";
import { sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { requireUser } from "../auth/require-user.ts";

/** I8 §4.1: the first-run checklist, derived from what exists. Human session only. */
export const setupRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.addHook("onRequest", requireUser);

  app.get("/api/setup", { schema: { response: { 200: setupStatusSchema } } }, async () => {
    const [r] = await db.execute<{ c: boolean; t: boolean; a: boolean }>(sql`
      select exists(select 1 from credentials) as c,
             exists(select 1 from templates)   as t,
             exists(select 1 from agents)      as a`);
    if (!r) throw new Error("setup query returned no row");
    return { hasCredential: r.c, hasTemplate: r.t, hasAgent: r.a };
  });
};
