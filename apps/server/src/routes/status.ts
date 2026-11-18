import { statusSchema } from "@open-factory/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type postgres from "postgres";
import { FACTORY_VERSION } from "../version.ts";

export const statusRoutes: FastifyPluginAsyncZod<{ sql: postgres.Sql }> = async (app, { sql }) => {
  app.get("/api/status", { schema: { response: { 200: statusSchema } } }, async () => {
    let db: "ok" | "error" = "ok";
    try {
      await sql`select 1`;
    } catch {
      db = "error";
    }
    return { version: FACTORY_VERSION, db };
  });
};
