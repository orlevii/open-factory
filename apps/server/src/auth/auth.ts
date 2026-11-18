import { type Db, schema } from "@open-factory/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Config } from "../config.ts";
import { authSecret } from "../crypto/keys.ts";
import { authOptions } from "./options.ts";

export function createAuth(config: Config, db: Db) {
  const trustedOrigins = [
    config.publicOrigin,
    ...(config.isProduction ? [] : [config.devWebOrigin]),
  ];
  return betterAuth(
    authOptions({
      secret: authSecret(config.secretKey),
      baseURL: config.publicUrl,
      trustedOrigins,
      database: drizzleAdapter(db, { provider: "pg", schema, usePlural: true }),
      // Operators come from the callback (the db package's drizzle instance): pnpm installs a
      // second drizzle-orm peer variant for this package (kysely via better-auth), whose `eq`
      // is type-incompatible with the db package's schema.
      handleExists: async (handle) =>
        (await db.query.users.findFirst({
          columns: { id: true },
          where: (u, { eq }) => eq(u.handle, handle),
        })) !== undefined,
    }),
  );
}
export type Auth = ReturnType<typeof createAuth>;
