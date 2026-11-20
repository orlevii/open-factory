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

  async listPending(): Promise<InviteItem[]> {
    const rows = await this.d.db
      .select()
      .from(schema.invites)
      .where(
        and(
          isNull(schema.invites.usedAt),
          isNull(schema.invites.revokedAt),
          gt(schema.invites.expiresAt, this.d.now()),
        ),
      )
      .orderBy(asc(schema.invites.createdAt), asc(schema.invites.id));
    return rows.map(toItem);
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
    const [row] = await this.d.db.select().from(schema.invites).where(eq(schema.invites.id, id));
    if (!row) throw notFound();
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

  /** One lookup by hash; unknown, used, revoked and expired all give null (one indistinguishable failure). */
  async check(token: string, tx: Exec = this.d.db): Promise<{ id: string } | null> {
    const [row] = await tx
      .select({ id: schema.invites.id })
      .from(schema.invites)
      .where(
        and(
          eq(schema.invites.tokenHash, hashToken(token)),
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
