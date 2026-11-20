import { type Db, schema } from "@open-factory/db";
import type { UserAdminItem } from "@open-factory/shared";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { EventBus } from "../agents/event-bus.ts";
import { ApiError } from "../errors.ts";

/** S10 spec §9.4: list, disable and enable users. Every user is an admin. */
export class UserAdminService {
  constructor(private readonly d: { db: Db; now: () => Date; bus: EventBus }) {}

  async list(): Promise<UserAdminItem[]> {
    const rows = await this.d.db
      .select()
      .from(schema.users)
      .orderBy(asc(schema.users.createdAt), asc(schema.users.id));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      handle: r.handle,
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
        .for("update");
      const [target] = await tx
        .select({ handle: schema.users.handle, disabledAt: schema.users.disabledAt })
        .from(schema.users)
        .where(eq(schema.users.id, targetId));
      if (!target) throw notFound();
      if (target.disabledAt === null) {
        if (!enabled.some((u) => u.id !== targetId)) {
          throw new ApiError(
            409,
            "last_enabled_user",
            `@${target.handle} is the last enabled user. Enable someone else first.`,
          );
        }
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
    this.d.bus.publishAll({ type: "users_changed" });
    return { revokedInvites };
  }

  /** Clears `disabled_at`; revoked invites stay revoked. */
  async enable(targetId: string): Promise<void> {
    const rows = await this.d.db
      .update(schema.users)
      .set({ disabledAt: null, disabledBy: null })
      .where(eq(schema.users.id, targetId))
      .returning({ id: schema.users.id });
    if (rows.length === 0) throw notFound();
    this.d.bus.publishAll({ type: "users_changed" });
  }
}

const notFound = () => new ApiError(404, "user_not_found", "There is no such user.");
