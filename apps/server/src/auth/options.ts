import { handleSchema } from "@open-factory/shared";
import { APIError, type BetterAuthOptions } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { bearer } from "better-auth/plugins";

export interface AuthOptionParams {
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
  database: BetterAuthOptions["database"];
  /** Returns true if the handle is already used. */
  handleExists?: (handle: string) => Promise<boolean>;
}

export function authOptions(p: AuthOptionParams) {
  return {
    secret: p.secret,
    baseURL: p.baseURL,
    basePath: "/api/auth",
    trustedOrigins: p.trustedOrigins,
    database: p.database,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      requireEmailVerification: false,
      autoSignIn: true,
    },
    user: {
      additionalFields: {
        handle: { type: "string", required: true, input: true, validator: { input: handleSchema } },
      },
    },
    plugins: [bearer()],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-up/email" || !p.handleExists) return;
        const handle = (ctx.body as { handle?: unknown } | undefined)?.handle;
        if (typeof handle === "string" && (await p.handleExists(handle))) {
          throw new APIError("UNPROCESSABLE_ENTITY", {
            code: "HANDLE_TAKEN",
            message: "That handle is already taken",
          });
        }
      }),
    },
  } satisfies BetterAuthOptions;
}
