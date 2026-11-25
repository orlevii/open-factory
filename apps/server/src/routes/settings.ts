import { type Db, schema } from "@open-factory/db";
import {
  type FactorySettingsDto,
  factorySettingsSchema,
  patchFactorySettingsSchema,
} from "@open-factory/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { requireUser } from "../auth/require-user.ts";
import { localRuntimeAllowed } from "../config.ts";
import { ApiError } from "../errors.ts";

/** S10 §8.3: the factory settings, human session only; the local runtime flag is env-only (Q7) and read-only here. */
export const settingsRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  // onRequest, not preHandler: auth must come before validation (401 before 400).
  app.addHook("onRequest", requireUser);

  app.get(
    "/api/settings/factory",
    { schema: { response: { 200: factorySettingsSchema } } },
    async () => dto(app, db),
  );

  // The body is parsed here, not by a route schema, so every rejection is `invalid_settings` (strict: never ignored).
  app.patch(
    "/api/settings/factory",
    { schema: { response: { 200: factorySettingsSchema } } },
    async (req) => {
      const r = patchFactorySettingsSchema.safeParse(req.body ?? {});
      if (!r.success) {
        const fields: Record<string, string> = {};
        for (const issue of r.error.issues) {
          const field = issue.path[0] ?? (issue.code === "unrecognized_keys" ? issue.keys[0] : "");
          if (field !== undefined && field !== "" && !(String(field) in fields)) {
            fields[String(field)] = issue.message;
          }
        }
        throw new ApiError(
          400,
          "invalid_settings",
          r.error.issues[0]?.message ?? "Invalid settings.",
          {
            fields,
          },
        );
      }
      const patch = Object.fromEntries(
        Object.entries(r.data).filter(([, v]) => v !== undefined),
      ) as typeof r.data;
      // An empty patch changes nothing: no write, no editor stamp, no frame.
      if (Object.keys(patch).length === 0) return dto(app, db);
      if (!req.user) throw new Error("requireUser did not set request.user");
      await app.factorySettings.update(patch, req.user.id);
      app.bus.publishAll({ type: "settings_changed" });
      return dto(app, db);
    },
  );
};

async function dto(app: FastifyInstance, db: Db): Promise<FactorySettingsDto> {
  const s = app.factorySettings.get();
  const [editor] = s.updatedBy
    ? await db
        .select({ handle: schema.users.handle })
        .from(schema.users)
        .where(eq(schema.users.id, s.updatedBy))
    : [];
  return {
    warmWindowMinutes: s.warmWindowMinutes,
    memberUpdateDebounceSeconds: s.memberUpdateDebounceSeconds,
    allowLocalRuntime: localRuntimeAllowed(app.config),
    updatedAt: s.updatedAt?.toISOString() ?? null,
    updatedBy: editor ? `@${editor.handle}` : null,
  };
}
