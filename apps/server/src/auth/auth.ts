import { type Db, schema } from "@open-factory/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Config } from "../config.ts";
import { authSecret } from "../crypto/keys.ts";
import { isNameTaken } from "../messaging/principals.ts";
import { signUpContext } from "../users/sign-up-gate.ts";
import { authOptions } from "./options.ts";
import { trustedOrigins } from "./origins.ts";

export function createAuth(config: Config, db: Db) {
  return betterAuth(
    authOptions({
      secret: authSecret(config.secretKey),
      baseURL: config.publicUrl,
      trustedOrigins: trustedOrigins(config),
      database: drizzleAdapter(db, { provider: "pg", schema, usePlural: true }),
      nameTaken: async (n) => {
        const taken = await isNameTaken(db, n);
        // Reserved handles fall through to handleSchema validation (400), not HANDLE_TAKEN.
        return taken === "user" || taken === "agent";
      },
      mayCreateUser: () => signUpContext.getStore()?.allowed === true,
    }),
  );
}
export type Auth = ReturnType<typeof createAuth>;
