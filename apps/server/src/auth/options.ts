import { randomUUID } from "node:crypto";
import { EMAIL_MAX, MSG, USER_NAME_MAX } from "@open-factory/shared";
import { APIError, type BetterAuthOptions } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { bearer } from "better-auth/plugins";

export interface AuthOptionParams {
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
  database: BetterAuthOptions["database"];
  /** The id for the user being created inside the sign-up gate: its principal's id, so `users.id = principals.id`. */
  newUserId?: () => string | undefined;
  /** True only inside the sign-up gate (S10 §9.3); without it no user can be created, not even the first. */
  mayCreateUser?: () => boolean;
  /** True when the user is disabled (S10 §9.4); no session can be created for them. */
  isDisabled?: (userId: string) => Promise<boolean>;
  /** better-auth's scrypt when absent; tests pass a cheap one (password hashing dominated their CPU time). */
  passwordHasher?: PasswordHasher;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(data: { hash: string; password: string }): Promise<boolean>;
}

/**
 * The name and email length limits (spec §13.2, the raw name, so padding can't bypass the cap) for a better-auth endpoint path and its body, or null.
 * Input only: a body without `name` passes, so an old stored name longer than the limit never blocks an update.
 */
export function inputLengthError(
  path: string,
  body: unknown,
): { code: "NAME_TOO_LONG" | "EMAIL_TOO_LONG"; message: string } | null {
  if (path !== "/sign-up/email" && path !== "/update-user") return null;
  if (!body || typeof body !== "object") return null;
  const { name, email } = body as { name?: unknown; email?: unknown };
  if (typeof name === "string" && name.length > USER_NAME_MAX) {
    return { code: "NAME_TOO_LONG", message: MSG.userNameLength };
  }
  if (path === "/sign-up/email" && typeof email === "string" && email.length > EMAIL_MAX) {
    return { code: "EMAIL_TOO_LONG", message: MSG.emailLength };
  }
  return null;
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
      ...(p.passwordHasher ? { password: p.passwordHasher } : {}),
    },
    advanced: {
      database: {
        // A user's id is its principal's (created in `handleSignUp`); every other row gets a random UUID.
        generateId: ({ model }) => (model === "user" ? p.newUserId?.() : undefined) ?? randomUUID(),
      },
    },
    user: {
      additionalFields: {
        // input: false: sign-up and update-user can't set it (V2); it comes back on getSession.
        disabledAt: { type: "date", required: false, input: false },
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
      session: {
        create: {
          // S10 §9.4 (the admin plugin's ban pattern): no sign-in method creates a session for a disabled user.
          before: async (session) => {
            if (await p.isDisabled?.(session.userId)) {
              throw new APIError("FORBIDDEN", {
                code: "USER_DISABLED",
                message: "This account is disabled.",
              });
            }
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        const tooLong = inputLengthError(ctx.path, ctx.body);
        if (tooLong) throw new APIError("BAD_REQUEST", tooLong);
      }),
    },
  } satisfies BetterAuthOptions;
}
