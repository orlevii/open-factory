import { randomUUID } from "node:crypto";
import { type Db, schema } from "@open-factory/db";
import type { CredentialKind, CredentialSummary } from "@open-factory/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { AgentRuntimes } from "../agents/runtimes.ts";
import { type Vault, VaultError } from "../crypto/vault.ts";
import { inUseViolation, pgCode, tags } from "../db-errors.ts";
import { ApiError } from "../errors.ts";
import type { CredentialVerifier, VerifyResult } from "./verify.ts";

const aad = (id: string) => `credentials:${id}`;

/** Display slugs, deduped: a spawned agent shows as its spawner. */
const slugs = (list: { slug: string }[]) => [...new Set(list.map((a) => a.slug))];

export class CredentialService {
  constructor(
    private readonly d: {
      db: Db;
      vault: Vault;
      verifier: CredentialVerifier;
      runtimes: AgentRuntimes;
      now: () => Date;
      log?: { warn: (obj: object, msg: string) => void };
    },
  ) {}

  private async users(credentialId: string) {
    const rows = await this.d.db
      .select({
        id: schema.agents.id,
        slug: schema.agents.slug,
        archivedAt: schema.agents.archivedAt,
        kind: schema.agents.kind,
        reportsTo: schema.agents.reportsTo,
      })
      .from(schema.agents)
      .where(and(eq(schema.agents.credentialId, credentialId), isNull(schema.agents.terminatedAt)));
    // A live spawned agent counts as its spawner: the human fixes the persistent agent's credential.
    const spawnerIds = [
      ...new Set(rows.flatMap((r) => (r.kind === "ephemeral" && r.reportsTo ? [r.reportsTo] : []))),
    ];
    const spawners = new Map(
      spawnerIds.length
        ? (
            await this.d.db
              .select({ id: schema.agents.id, slug: schema.agents.slug })
              .from(schema.agents)
              .where(inArray(schema.agents.id, spawnerIds))
          ).map((a) => [a.id, a.slug])
        : [],
    );
    const named = rows.map((r) => ({
      id: r.id,
      slug: (r.kind === "ephemeral" && r.reportsTo && spawners.get(r.reportsTo)) || r.slug,
      archivedAt: r.kind === "ephemeral" ? null : r.archivedAt,
    }));
    const bySlug = (a: { slug: string }, b: { slug: string }) => a.slug.localeCompare(b.slug);
    return {
      active: named.filter((r) => !r.archivedAt).sort(bySlug),
      archived: named.filter((r) => r.archivedAt).sort(bySlug),
    };
  }

  private async summarize(row: typeof schema.credentials.$inferSelect): Promise<CredentialSummary> {
    const u = await this.users(row.id);
    return {
      name: row.name,
      kind: row.kind,
      lastVerifiedAt: row.lastVerifiedAt ? row.lastVerifiedAt.toISOString() : null,
      lastError: row.lastError,
      usedBy: slugs(u.active),
      archivedUsedBy: slugs(u.archived),
      rateLimit: row.rlObservedAt
        ? {
            status: row.rlStatus ?? "allowed",
            type: row.rlType,
            utilization: row.rlUtilization,
            resetsAt: row.rlResetsAt ? row.rlResetsAt.toISOString() : null,
            observedAt: row.rlObservedAt.toISOString(),
          }
        : null,
      ...(row.rateLimitedUntil && row.rateLimitedUntil > this.d.now()
        ? { pausedUntil: row.rateLimitedUntil.toISOString(), pauseExact: row.rateLimitExact }
        : {}),
    };
  }

  private async rowByName(name: string) {
    const [row] = await this.d.db
      .select()
      .from(schema.credentials)
      .where(eq(schema.credentials.name, name));
    if (!row) throw new ApiError(404, "credential_not_found", `No credential named ${name}.`);
    return row;
  }

  private exists(name: string) {
    return new ApiError(409, "credential_exists", `A credential named ${name} already exists.`);
  }

  private async inUse(id: string) {
    const u = await this.users(id);
    if (!u.active.length && !u.archived.length) return undefined;
    const usedBy = slugs(u.active);
    const archivedUsedBy = slugs(u.archived);
    const message = [
      usedBy.length ? `Used by ${tags(usedBy)}. Change their credential first.` : "",
      archivedUsedBy.length
        ? `Archived agents ${tags(archivedUsedBy)} still reference it. Edit them first.`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    return new ApiError(409, "credential_in_use", message, { usedBy, archivedUsedBy });
  }

  private assertVerified(r: VerifyResult) {
    if (r.ok) return;
    throw new ApiError(
      422,
      r.kind === "rejected" ? "credential_rejected" : "credential_unverifiable",
      r.message,
    );
  }

  async list(): Promise<CredentialSummary[]> {
    const rows = await this.d.db.select().from(schema.credentials);
    return Promise.all(
      rows.sort((a, b) => a.name.localeCompare(b.name)).map((r) => this.summarize(r)),
    );
  }

  async create(b: {
    name: string;
    kind: CredentialKind;
    value: string;
  }): Promise<CredentialSummary> {
    // Cheap pre-check so a duplicate name doesn't cost a paid verification turn; the unique
    // violation below still covers a race.
    const [taken] = await this.d.db
      .select({ id: schema.credentials.id })
      .from(schema.credentials)
      .where(eq(schema.credentials.name, b.name));
    if (taken) throw this.exists(b.name);
    this.assertVerified(await this.d.verifier.verify(b.kind, b.value));
    const id = randomUUID();
    try {
      const [row] = await this.d.db
        .insert(schema.credentials)
        .values({
          id,
          name: b.name,
          kind: b.kind,
          valueEnc: this.d.vault.seal(b.value, aad(id)),
          lastVerifiedAt: new Date(),
        })
        .returning();
      if (!row) throw new Error("credential insert returned no row");
      return this.summarize(row);
    } catch (err) {
      if (pgCode(err, "23505")) throw this.exists(b.name);
      throw err;
    }
  }

  async replace(name: string, value: string): Promise<CredentialSummary> {
    const row = await this.rowByName(name);
    this.assertVerified(await this.d.verifier.verify(row.kind, value));
    const [updated] = await this.d.db
      .update(schema.credentials)
      .set({
        valueEnc: this.d.vault.seal(value, aad(row.id)),
        lastVerifiedAt: new Date(),
        lastError: null,
      })
      .where(eq(schema.credentials.id, row.id))
      .returning();
    if (!updated) throw new ApiError(404, "credential_not_found", `No credential named ${name}.`);
    // One failed restart is logged by slug and never aborts the rest or the write.
    const active = (await this.users(row.id)).active;
    const results = await Promise.allSettled(
      active.map((a) => this.d.runtimes.requestRestart(a.id)),
    );
    results.forEach((r, i) => {
      if (r.status === "rejected")
        this.d.log?.warn({ slug: active[i]?.slug }, "restart after credential change failed");
    });
    return this.summarize(updated);
  }

  async reverify(name: string): Promise<CredentialSummary> {
    const row = await this.rowByName(name);
    let value: string;
    try {
      value = this.d.vault.open(row.valueEnc, aad(row.id));
    } catch (err) {
      if (err instanceof VaultError)
        throw new ApiError(
          409,
          "credential_undecryptable",
          `Can't decrypt credential ${row.name}. Was FACTORY_SECRET_KEY changed?`,
        );
      throw err;
    }
    const r = await this.d.verifier.verify(row.kind, value);
    const [updated] = await this.d.db
      .update(schema.credentials)
      .set(r.ok ? { lastVerifiedAt: new Date(), lastError: null } : { lastError: r.message })
      .where(eq(schema.credentials.id, row.id))
      .returning();
    return this.summarize(updated ?? row);
  }

  async remove(name: string): Promise<void> {
    const row = await this.rowByName(name);
    const busy = await this.inUse(row.id);
    if (busy) throw busy;
    try {
      await this.d.db.delete(schema.credentials).where(eq(schema.credentials.id, row.id));
    } catch (err) {
      // An agent took the credential after the check: the FK restricts the delete.
      if (inUseViolation(err)) throw (await this.inUse(row.id)) ?? err;
      throw err;
    }
  }
}
