import { AsyncLocalStorage } from "node:async_hooks";
import { type Db, schema } from "@open-factory/db";
import { handleSchema, MSG, type SignUpState } from "@open-factory/shared";
import { count, sql } from "drizzle-orm";
import type { EventBus } from "../agents/event-bus.ts";
import type { Auth } from "../auth/auth.ts";
import { inputLengthError } from "../auth/options.ts";
import type { PublishPrincipal } from "../principals/principal-events.ts";
import {
  createPrincipal,
  HandleTakenError,
  type Principal,
} from "../principals/principal-store.ts";
import { KeyedMutex } from "../workspace/lock.ts";
import type { InviteService } from "./invites.ts";

/**
 * Set only by `handleSignUp`; better-auth's `user.create.before` refuses any user creation without it
 * (S10 §9.3 backstop), whatever path or endpoint reached better-auth.
 */
export const signUpContext = new AsyncLocalStorage<{ allowed: boolean; userId: string }>();

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

export interface SignUpDeps {
  db: Db;
  invites: InviteService;
  auth: Pick<Auth, "handler">;
  bus: EventBus;
  /** Tells the browsers about the new person once their user row has committed. */
  publishPrincipal: PublishPrincipal;
  log: { error: (obj: object, msg: string) => void };
}

/**
 * The only way to create a user (S10 §9.3): serialized, invite-checked unless the factory has no users yet,
 * given a principal (handle validated and claimed; it is the new user's id), forwarded to better-auth without the
 * `invite` and `handle` fields inside `signUpContext`, the invite marked used on success (a failure removes the
 * principal again), and `users_changed` published (S10 §11).
 */
export async function handleSignUp(d: SignUpDeps, req: Request, body: unknown): Promise<Response> {
  return signUpMutex.run("sign-up", async () => {
    const fields =
      body && typeof body === "object" && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>) }
        : null;
    const invite = fields?.invite;
    if (fields) delete fields.invite;

    let inviteId: string | null = null;
    if (await hasUsers(d.db)) {
      // "" counts as missing, as on sign-up-state.
      if (invite === undefined || invite === null || invite === "") {
        return forbidden("invite_required", INVITE_REQUIRED_MESSAGE);
      }
      const found = typeof invite === "string" ? await d.invites.check(invite) : null;
      if (!found) return forbidden("invite_invalid", INVITE_INVALID_MESSAGE);
      inviteId = found.id;
    }

    // Before the handle check, so a too-long name or email is named even when the handle is missing (spec §13.2).
    const tooLong = inputLengthError("/sign-up/email", body);
    if (tooLong) return Response.json(tooLong, { status: 400 });
    // The handle is the principal's, not a better-auth field: validated and claimed here, then stripped from the body.
    const handle = handleSchema.safeParse(fields?.handle);
    if (!handle.success) {
      return Response.json(
        {
          code: "VALIDATION_ERROR",
          message: handle.error.issues[0]?.message ?? MSG.handleLength,
        },
        { status: 400 },
      );
    }
    let principal: Principal;
    try {
      principal = await createPrincipal(d.db, "human", handle.data);
    } catch (err) {
      if (err instanceof HandleTakenError)
        return Response.json({ code: "HANDLE_TAKEN", message: MSG.handleTaken }, { status: 422 });
      throw err;
    }
    if (fields) delete fields.handle;

    const headers = new Headers(req.headers);
    headers.delete("content-length");
    const forwarded = new Request(req.url, {
      method: req.method,
      headers,
      body: fields ? JSON.stringify(fields) : body === undefined ? undefined : JSON.stringify(body),
    });
    // Cleanup must not replace the sign-up's own error or response.
    const dropFailed = (err: unknown) =>
      d.log.error({ err, userId: principal.id }, "dropping the unused principal failed");
    let res: Response;
    try {
      res = await signUpContext.run({ allowed: true, userId: principal.id }, () =>
        d.auth.handler(forwarded),
      );
    } catch (err) {
      await dropUnusedPrincipal(d.db, principal.id).catch(dropFailed);
      throw err;
    }

    if (!res.ok) {
      await dropUnusedPrincipal(d.db, principal.id).catch(dropFailed);
      return res;
    }
    if (inviteId && !(await d.invites.markUsed(inviteId, principal.id))) {
      d.log.error(
        { inviteId, userId: principal.id },
        "sign-up succeeded but the invite was already marked used",
      );
    }
    d.bus.publishAll({ type: "users_changed" });
    await d.publishPrincipal(principal.id);
    return res;
  });
}

/** A failed sign-up leaves no principal behind (a user row would have kept it). */
async function dropUnusedPrincipal(db: Db, id: string): Promise<void> {
  await db.execute(
    sql`DELETE FROM principals WHERE id = ${id} AND NOT EXISTS (SELECT 1 FROM users WHERE users.id = ${id})`,
  );
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
