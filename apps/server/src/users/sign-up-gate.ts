import { AsyncLocalStorage } from "node:async_hooks";
import { type Db, schema } from "@open-factory/db";
import type { SignUpState } from "@open-factory/shared";
import { count } from "drizzle-orm";
import type { Auth } from "../auth/auth.ts";
import { KeyedMutex } from "../workspace/lock.ts";
import type { InviteService } from "./invites.ts";

/**
 * Set only by `handleSignUp`; better-auth's `user.create.before` refuses any user creation without it
 * (S10 §9.3 backstop), whatever path or endpoint reached better-auth.
 */
export const signUpContext = new AsyncLocalStorage<{ allowed: boolean }>();

/** Correct only because the factory is one server process (ADR 0013); a multi-instance deployment must replace this with
 *  a Postgres advisory lock. */
export const signUpMutex = new KeyedMutex();

const INVITE_REQUIRED_MESSAGE = "Sign-up needs an invite link from a member of this factory.";
const INVITE_INVALID_MESSAGE =
  "This invite link isn't valid anymore. Ask a member of this factory for a new one.";

const forbidden = (code: string, message: string) =>
  Response.json({ error: { code, message } }, { status: 403 });

async function hasUsers(db: Db): Promise<boolean> {
  const [row] = await db.select({ c: count() }).from(schema.users);
  return (row?.c ?? 0) > 0;
}

/**
 * The only way to create a user (S10 §9.3): serialized, invite-checked unless the factory has no users yet,
 * forwarded to better-auth without the `invite` field inside `signUpContext`, and the invite marked used on success.
 */
export async function handleSignUp(
  d: { db: Db; invites: InviteService; auth: Auth },
  req: Request,
  body: unknown,
): Promise<Response> {
  return signUpMutex.run("sign-up", async () => {
    const fields =
      body && typeof body === "object" && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>) }
        : null;
    const invite = fields?.invite;
    if (fields) delete fields.invite;

    let inviteId: string | null = null;
    if (await hasUsers(d.db)) {
      if (invite === undefined || invite === null) {
        return forbidden("invite_required", INVITE_REQUIRED_MESSAGE);
      }
      const found = typeof invite === "string" ? await d.invites.check(invite) : null;
      if (!found) return forbidden("invite_invalid", INVITE_INVALID_MESSAGE);
      inviteId = found.id;
    }

    const headers = new Headers(req.headers);
    headers.delete("content-length");
    const forwarded = new Request(req.url, {
      method: req.method,
      headers,
      body: fields ? JSON.stringify(fields) : body === undefined ? undefined : JSON.stringify(body),
    });
    const res = await signUpContext.run({ allowed: true }, () => d.auth.handler(forwarded));

    if (inviteId && res.ok) {
      const created = (await res
        .clone()
        .json()
        .catch(() => null)) as { user?: { id?: unknown } } | null;
      const userId = created?.user?.id;
      if (typeof userId !== "string") throw new Error("sign-up succeeded without a user id");
      await d.invites.markUsed(inviteId, userId);
    }
    return res;
  });
}

/** For the sign-up page (S10 §9.3); public. */
export async function signUpState(
  d: { db: Db; invites: InviteService },
  invite: string | undefined,
): Promise<SignUpState> {
  const bootstrap = !(await hasUsers(d.db));
  if (invite === undefined || invite === "") return { bootstrap, invite: "missing" };
  return { bootstrap, invite: (await d.invites.check(invite)) ? "valid" : "invalid" };
}
