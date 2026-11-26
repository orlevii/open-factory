import { type Db, schema } from "@open-factory/db";
import type { UserAdminItem } from "@open-factory/shared";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { EventBus } from "../agents/event-bus.ts";
import type { SignInAttempts } from "../credentials/sign-in/attempts.ts";
import { ApiError } from "../errors.ts";

/** S10 spec §9.4: list, disable and enable users. Every user is an admin. */
export class UserAdminService {
  constructor(
    private readonly d: {
      db: Db;
      now: () => Date;
      bus: EventBus;
      signIn: Pick<SignInAttempts, "endFor">;
    },
  ) {}

  async list(): Promise<UserAdminItem[]> {
    const rows = await this.d.db
      .select({ u: schema.users, handle: schema.principals.handle })
      .from(schema.users)
      .innerJoin(schema.principals, eq(schema.principals.id, schema.users.id))
      .orderBy(asc(schema.users.createdAt), asc(schema.users.id));
    return rows.map(({ u: r, handle }) => ({
      id: r.id,
      name: r.name,
      handle,
      email: r.email,
      createdAt: r.createdAt.toISOString(),
      disabledAt: r.disabledAt?.toISOString() ?? null,
    }));
  }

  /**
   * One transaction: lock the enabled users (in id order, so concurrent disables queue instead of
   * deadlocking, and two admins disabling each other can't leave zero), mark the user disabled, delete
   * every session row (cookie and bearer/CLI alike) and revoke their pending invites. Sockets close and
   * `users_changed` goes out only after the commit.
   *
   * FOR NO KEY UPDATE, not FOR UPDATE: two disables still serialize, but sign-ins and invite creates
   * (FOR KEY SHARE through their foreign keys) don't wait on it. The actor must still be among the locked
   * enabled users: an actor disabled by a disable that committed first is refused.
   */
  async disable(actorId: string, targetId: string): Promise<{ revokedInvites: number }> {
    if (actorId === targetId) {
      throw new ApiError(409, "cannot_disable_self", "You can't disable yourself.");
    }
    const now = this.d.now();
    const revokedInvites = await this.d.db.transaction(async (tx) => {
      const enabled = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(isNull(schema.users.disabledAt))
        .orderBy(asc(schema.users.id))
        .for("no key update");
      const [target] = await tx
        .select({ handle: schema.principals.handle, disabledAt: schema.users.disabledAt })
        .from(schema.users)
        .innerJoin(schema.principals, eq(schema.principals.id, schema.users.id))
        .where(eq(schema.users.id, targetId));
      if (!target) throw notFound();
      if (target.disabledAt === null && !enabled.some((u) => u.id !== targetId)) {
        throw new ApiError(
          409,
          "last_enabled_user",
          `@${target.handle} is the last enabled user. Enable someone else first.`,
        );
      }
      // After last_enabled_user, so two admins disabling each other still get that 409.
      if (!enabled.some((u) => u.id === actorId)) throw actorDisabled();
      if (target.disabledAt === null) {
        // I9 §4.5: a human who manages agents can't be disabled while they report to them; move them first.
        const managed = await tx
          .select({ slug: schema.agents.slug })
          .from(schema.agents)
          .where(and(eq(schema.agents.reportsTo, targetId), isNull(schema.agents.terminatedAt)))
          .orderBy(asc(schema.agents.slug));
        if (managed.length)
          throw new ApiError(
            409,
            "manages_agents",
            `@${target.handle} manages ${managed.map((a) => `@${a.slug}`).join(", ")}. Move them to another manager first.`,
            { agents: managed.map((a) => a.slug) },
          );
        await tx
          .update(schema.users)
          .set({ disabledAt: now, disabledBy: actorId })
          .where(eq(schema.users.id, targetId));
      }
      // Also for an already disabled user: whatever sessions or invites remain are removed.
      await tx.delete(schema.sessions).where(eq(schema.sessions.userId, targetId));
      const revoked = await tx
        .update(schema.invites)
        .set({ revokedAt: now })
        .where(
          and(
            eq(schema.invites.createdBy, targetId),
            isNull(schema.invites.usedAt),
            isNull(schema.invites.revokedAt),
            gt(schema.invites.expiresAt, now),
          ),
        )
        .returning({ id: schema.invites.id });
      return revoked.length;
    });
    this.d.bus.closeUser(targetId);
    this.d.signIn.endFor(targetId);
    this.d.bus.publishAll({ type: "users_changed" });
    return { revokedInvites };
  }

  /**
   * Clears `disabled_at`; revoked invites stay revoked. The actor must still be enabled (FOR SHARE, so a
   * concurrent disable of the actor is serialized with this). Enabling a disabled user also deletes any
   * session row they still have: one can only exist because a sign-in raced the disable (its
   * `session.create.before` read `disabled_at` before the disable committed), so "signed out everywhere"
   * holds after enable too.
   */
  async enable(actorId: string, targetId: string): Promise<void> {
    await this.d.db.transaction(async (tx) => {
      const [actor] = await tx
        .select({ disabledAt: schema.users.disabledAt })
        .from(schema.users)
        .where(eq(schema.users.id, actorId))
        .for("share");
      if (!actor || actor.disabledAt) throw actorDisabled();
      const [target] = await tx
        .select({ disabledAt: schema.users.disabledAt })
        .from(schema.users)
        .where(eq(schema.users.id, targetId))
        .for("no key update");
      if (!target) throw notFound();
      if (target.disabledAt === null) return;
      await tx.delete(schema.sessions).where(eq(schema.sessions.userId, targetId));
      await tx
        .update(schema.users)
        .set({ disabledAt: null, disabledBy: null })
        .where(eq(schema.users.id, targetId));
    });
    this.d.bus.publishAll({ type: "users_changed" });
  }

  /** One primary-key lookup; an unknown user counts as disabled. */
  async isDisabled(userId: string): Promise<boolean> {
    const [row] = await this.d.db
      .select({ disabledAt: schema.users.disabledAt })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    return !row || row.disabledAt !== null;
  }
}

const notFound = () => new ApiError(404, "user_not_found", "There is no such user.");
/** The actor was disabled after its request was authenticated: treated as signed out. */
const actorDisabled = () => new ApiError(401, "unauthorized", "Not signed in");
