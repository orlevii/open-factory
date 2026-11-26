import path from "node:path";
import { schema } from "@open-factory/db";
import {
  nameSchema,
  normaliseRef,
  type PrincipalItem,
  principalsQuerySchema,
  principalsResponseSchema,
} from "@open-factory/shared";
import { eq, inArray } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { requireUser } from "../auth/require-user.ts";
import { avatarStat } from "../templates/avatar.ts";

export const principalsRoutes: FastifyPluginAsyncZod = async (app) => {
  // onRequest, not preHandler: auth must come before validation (401 before 400).
  app.addHook("onRequest", requireUser);

  app.get(
    "/api/principals",
    { schema: { querystring: principalsQuerySchema, response: { 200: principalsResponseSchema } } },
    async (req) => {
      const refs = req.query.refs?.flatMap((r) => normaliseRef(r) ?? []);
      const rows =
        refs && !refs.length
          ? []
          : await app.db
              .select({
                id: schema.principals.id,
                ref: schema.principals.ref,
                kind: schema.principals.kind,
                handle: schema.principals.handle,
                userName: schema.users.name,
                disabledAt: schema.users.disabledAt,
                displayName: schema.agents.displayName,
                template: schema.agents.template,
                color: schema.agents.color,
                archivedAt: schema.agents.archivedAt,
                terminatedAt: schema.agents.terminatedAt,
              })
              .from(schema.principals)
              .leftJoin(schema.users, eq(schema.users.id, schema.principals.id))
              .leftJoin(schema.agents, eq(schema.agents.id, schema.principals.id))
              .where(refs ? inArray(schema.principals.ref, refs) : undefined);

      // One avatar check per distinct template, live from disk like the agent summaries.
      const avatarOf = new Map(
        await Promise.all(
          [...new Set(rows.flatMap((r) => (r.template ? [r.template] : [])))].map(
            async (t) =>
              [
                t,
                nameSchema.safeParse(t).success
                  ? (await avatarStat(path.join(app.templates.dir, t), app.templates.dir)).version
                  : null,
              ] as const,
          ),
        ),
      );

      const principals = rows.map((r): PrincipalItem => {
        const base = { id: r.id, ref: r.ref, kind: r.kind, handle: r.handle };
        if (r.kind === "human")
          return {
            ...base,
            name: r.userName ?? r.handle,
            state: r.disabledAt ? "disabled" : "live",
            avatar: null,
          };
        return {
          ...base,
          name: r.displayName ?? r.handle,
          state: r.terminatedAt ? "terminated" : r.archivedAt ? "archived" : "live",
          avatar: r.template
            ? {
                template: r.template,
                avatarVersion: avatarOf.get(r.template) ?? null,
                color: r.color,
              }
            : null,
        };
      });
      return { principals };
    },
  );
};
