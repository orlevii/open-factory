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

/**
 * One better-auth instance for one public origin (`baseURL`). better-auth fixes a cookie's `Secure` flag and
 * `__Secure-` prefix once, from the base URL's scheme, so an app opened at an https and an http origin needs one
 * instance for each. They share the database, so a session is a session on either.
 */
export function createAuth(
  config: Config,
  db: Db,
  baseURL: string,
  passwordHasher?: PasswordHasher,
) {
  return betterAuth(
    authOptions({
      secret: authSecret(config.secretKey),
      baseURL,
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
