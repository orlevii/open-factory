import { type Db, schema } from "@open-factory/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import type { Config } from "../config.ts";
import { authSecret } from "../crypto/keys.ts";
import { claimHandle } from "../messaging/principals.ts";
import { signUpContext } from "../users/sign-up-gate.ts";
import { authOptions, type PasswordHasher } from "./options.ts";
import { trustedOrigins } from "./origins.ts";

export function createAuth(config: Config, db: Db, passwordHasher?: PasswordHasher) {
  return betterAuth(
    authOptions({
      secret: authSecret(config.secretKey),
      baseURL: config.publicUrl,
      trustedOrigins: trustedOrigins(config),
      passwordHasher,
      database: drizzleAdapter(db, { provider: "pg", schema, usePlural: true }),
      claim: (handle) => claimHandle(db, handle, "user"),
      mayCreateUser: () => signUpContext.getStore()?.allowed === true,
      // One primary-key lookup.
      isDisabled: async (userId) => {
        const [row] = await db
          .select({ disabledAt: schema.users.disabledAt })
          .from(schema.users)
          .where(eq(schema.users.id, userId));
        return row?.disabledAt != null;
      },
    }),
  );
}
export type Auth = ReturnType<typeof createAuth>;
