import { type Db, schema } from "@open-factory/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Config } from "../config.ts";
import { authSecret } from "../crypto/keys.ts";
import { authOptions } from "./options.ts";
import { trustedOrigins } from "./origins.ts";

export function createAuth(config: Config, db: Db) {
  return betterAuth(
    authOptions({
      secret: authSecret(config.secretKey),
      baseURL: config.publicUrl,
      trustedOrigins: trustedOrigins(config),
      database: drizzleAdapter(db, { provider: "pg", schema, usePlural: true }),
      // Operators come from the query callback rather than an `eq` import: this keeps them tied to
      // the db package's drizzle instance, so a future second drizzle-orm peer variant can't
      // introduce a type mismatch (defensive; the lockfile currently resolves a single variant).
      handleExists: async (handle) =>
        (await db.query.users.findFirst({
          columns: { id: true },
          where: (u, { eq }) => eq(u.handle, handle),
        })) !== undefined,
    }),
  );
}
export type Auth = ReturnType<typeof createAuth>;
