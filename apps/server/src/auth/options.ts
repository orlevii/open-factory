import { handleSchema } from "@open-factory/shared";
import { APIError, type BetterAuthOptions } from "better-auth";
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { bearer } from "better-auth/plugins";

export interface AuthOptionParams {
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
  database: BetterAuthOptions["database"];
  /** Returns true if the name already belongs to an agent or a human (one namespace, spec §7.1). */
  nameTaken?: (name: string) => Promise<boolean>;
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
        if ((ctx.path !== "/sign-up/email" && ctx.path !== "/update-user") || !p.nameTaken) return;
        const handle = (ctx.body as { handle?: unknown } | undefined)?.handle;
        if (typeof handle !== "string") return;
        if (ctx.path === "/update-user") {
          // Keeping one's own current handle is not a change.
          const session = await getSessionFromCtx(ctx);
          if ((session?.user as { handle?: string } | undefined)?.handle === handle) return;
        }
        // One rule (spec §7.1). A simultaneous sign-up and agent create with the same name is an accepted race; sends then fail with 'matches both'.
        if (await p.nameTaken(handle)) {
          throw new APIError("UNPROCESSABLE_ENTITY", {
            code: "HANDLE_TAKEN",
            message: "That handle is already taken",
          });
        }
      }),
    },
  } satisfies BetterAuthOptions;
}
