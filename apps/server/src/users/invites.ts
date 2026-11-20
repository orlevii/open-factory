import { createHash, randomBytes, randomUUID } from "node:crypto";
import { type Db, schema } from "@open-factory/db";
import type { InviteItem } from "@open-factory/shared";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { EventBus } from "../agents/event-bus.ts";
import type { Exec } from "../agents/event-store.ts";
import { ApiError } from "../errors.ts";

/** S10 spec §9.2. */
export const INVITE_TTL_MS = 7 * 86_400_000;
export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

type Row = typeof schema.invites.$inferSelect;
const toItem = (r: Row): InviteItem => ({
  id: r.id,
  createdBy: r.createdBy,
  createdAt: r.createdAt.toISOString(),
  expiresAt: r.expiresAt.toISOString(),
});

/** Invite links: a 256-bit token stored only as its sha256, single use, 7-day expiry, revocable. */
export class InviteService {
  constructor(private readonly d: { db: Db; now: () => Date; publicUrl: string; bus: EventBus }) {}

  async create(byUserId: string): Promise<{ invite: InviteItem; link: string }> {
    const token = randomBytes(32).toString("base64url");
    const now = this.d.now();
    const [row] = await this.d.db
      .insert(schema.invites)
      .values({
        id: randomUUID(),
        tokenHash: hashToken(token),
        createdBy: byUserId,
        createdAt: now,
        expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
      })
      .returning();
    this.d.bus.publishAll({ type: "users_changed" });
    return { invite: toItem(row as Row), link: `${this.d.publicUrl}/sign-up?invite=${token}` };
  }

  /** Pending: unused, unrevoked, unexpired, and created by a user who is still enabled (S10 §9.4). */
  async listPending(): Promise<InviteItem[]> {
    const rows = await this.d.db
      .select({ invite: schema.invites })
      .from(schema.invites)
      .innerJoin(schema.users, eq(schema.users.id, schema.invites.createdBy))
      .where(
        and(
          isNull(schema.users.disabledAt),
          isNull(schema.invites.usedAt),
          isNull(schema.invites.revokedAt),
          gt(schema.invites.expiresAt, this.d.now()),
        ),
      )
      .orderBy(asc(schema.invites.createdAt), asc(schema.invites.id));
    return rows.map((r) => toItem(r.invite));
  }

  async revoke(id: string): Promise<void> {
    const rows = await this.d.db
      .update(schema.invites)
      .set({ revokedAt: this.d.now() })
      .where(eq(schema.invites.id, id))
      .returning({ id: schema.invites.id });
    if (rows.length === 0) throw notFound();
    this.d.bus.publishAll({ type: "users_changed" });
  }

  async restore(id: string): Promise<void> {
    const [found] = await this.d.db
      .select({ invite: schema.invites, creatorDisabledAt: schema.users.disabledAt })
      .from(schema.invites)
      .innerJoin(schema.users, eq(schema.users.id, schema.invites.createdBy))
      .where(eq(schema.invites.id, id));
    if (!found) throw notFound();
    const row = found.invite;
    // Disabling a user revokes their invites for good (S10 §9.4, §12.10 "revoked invites stay revoked").
    if (found.creatorDisabledAt) {
      throw new ApiError(409, "invite_creator_disabled", "This invite's creator is disabled.");
    }
    if (row.usedAt) throw new ApiError(409, "invite_used", "This invite was already used.");
    if (row.expiresAt <= this.d.now()) {
      throw new ApiError(409, "invite_expired", "This invite has expired.");
    }
    await this.d.db
      .update(schema.invites)
      .set({ revokedAt: null })
      .where(and(eq(schema.invites.id, id), isNull(schema.invites.usedAt)));
    this.d.bus.publishAll({ type: "users_changed" });
  }

  /**
   * One lookup by hash; unknown, used, revoked, expired and a disabled creator all give null (one
   * indistinguishable failure). The creator's state is part of validity, so neither a restore nor an
   * invite created while its creator was being disabled can outlive the disable.
   */
  async check(token: string, tx: Exec = this.d.db): Promise<{ id: string } | null> {
    const [row] = await tx
      .select({ id: schema.invites.id })
      .from(schema.invites)
      .innerJoin(schema.users, eq(schema.users.id, schema.invites.createdBy))
      .where(
        and(
          eq(schema.invites.tokenHash, hashToken(token)),
          isNull(schema.users.disabledAt),
          isNull(schema.invites.usedAt),
          isNull(schema.invites.revokedAt),
          gt(schema.invites.expiresAt, this.d.now()),
        ),
      );
    return row ?? null;
  }

  /** Guarded UPDATE: true for the one caller that wins; `used_by` UNIQUE is the backstop. */
  async markUsed(id: string, userId: string): Promise<boolean> {
    const rows = await this.d.db
      .update(schema.invites)
      .set({ usedAt: this.d.now(), usedBy: userId })
      .where(and(eq(schema.invites.id, id), isNull(schema.invites.usedAt)))
      .returning({ id: schema.invites.id });
    return rows.length > 0;
  }
}

const notFound = () => new ApiError(404, "invite_not_found", "There is no such invite.");
