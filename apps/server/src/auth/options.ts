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
  /** True only inside the sign-up gate (S10 §9.3); without it no user can be created, not even the first. */
  mayCreateUser?: () => boolean;
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
    databaseHooks: {
      user: {
        create: {
          // The backstop (S10 §9.3, F2): whatever path or endpoint reached better-auth, a user is created
          // only through handleSignUp, which checks the invite. No zero-users exception here.
          before: async () => {
            if (!p.mayCreateUser?.()) {
              throw new APIError("FORBIDDEN", {
                code: "invite_required",
                message: "Sign-up needs an invite link from a member of this factory.",
              });
            }
          },
        },
      },
    },
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
