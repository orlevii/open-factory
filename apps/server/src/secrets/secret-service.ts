import { randomUUID } from "node:crypto";
import { type Db, schema } from "@open-factory/db";
import type { SecretSummary } from "@open-factory/shared";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { AgentRuntimes } from "../agents/runtimes.ts";
import type { Vault } from "../crypto/vault.ts";
import { pgCode } from "../db-errors.ts";
import { ApiError } from "../errors.ts";

const aad = (id: string) => `secrets:${id}`;

/** Values are write-only: nothing here returns, logs or throws a value. */
export class SecretService {
  constructor(
    private readonly d: {
      db: Db;
      vault: Vault;
      runtimes: AgentRuntimes;
      log?: { warn: (obj: object, msg: string) => void };
    },
  ) {}

  /** Restart every user; one failure is logged by handle and never aborts the rest or the write. */
  private async restartAll(users: { id: string; handle: string }[]) {
    const results = await Promise.allSettled(
      users.map((u) => this.d.runtimes.requestRestart(u.id)),
    );
    results.forEach((r, i) => {
      if (r.status === "rejected")
        this.d.log?.warn({ handle: users[i]?.handle }, "restart after secret change failed");
    });
  }

  /**
   * I2 §6.7: the agents whose effective secrets include `name`, neither archived nor terminated: their template's last
   * valid parse lists it, or their overlay does. Plus those agents' live spawned children, which inherit their spawner's
   * secrets at each start. Rotate and delete restart exactly these; the Secrets page lists them.
   */
  private async usedBy(name: string): Promise<{ id: string; handle: string }[]> {
    const { agents, principals, templates } = schema;
    const users = await this.d.db
      .select({ id: agents.id, handle: principals.handle })
      .from(agents)
      .innerJoin(principals, eq(principals.id, agents.id))
      .leftJoin(templates, eq(templates.name, agents.template))
      .where(
        and(
          isNull(agents.archivedAt),
          isNull(agents.terminatedAt),
          or(
            sql`${templates.lastValid}->'template'->'secrets' ? ${name}`,
            sql`${agents.config}->'template'->'secrets' ? ${name}`,
          ),
        ),
      );
    const children = users.length
      ? await this.d.db
          .select({ id: agents.id, handle: principals.handle })
          .from(agents)
          .innerJoin(principals, eq(principals.id, agents.id))
          .where(
            and(
              inArray(
                agents.reportsTo,
                users.map((u) => u.id),
              ),
              eq(agents.kind, "ephemeral"),
              isNull(agents.terminatedAt),
            ),
          )
      : [];
    const byId = new Map([...users, ...children].map((u) => [u.id, u]));
    return [...byId.values()].sort((x, y) => x.handle.localeCompare(y.handle));
  }

  private summary(row: typeof schema.secrets.$inferSelect, users: { handle: string }[]) {
    return {
      name: row.name,
      updatedAt: row.updatedAt.toISOString(),
      usedBy: users.map((u) => u.handle),
    } satisfies SecretSummary;
  }

  async list(): Promise<SecretSummary[]> {
    const rows = await this.d.db.select().from(schema.secrets);
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return Promise.all(rows.map(async (r) => this.summary(r, await this.usedBy(r.name))));
  }

  private async update(id: string, value: string) {
    const [row] = await this.d.db
      .update(schema.secrets)
      .set({ valueEnc: this.d.vault.seal(value, aad(id)), updatedAt: new Date() })
      .where(eq(schema.secrets.id, id))
      .returning();
    return row;
  }

  async put(name: string, value: string): Promise<SecretSummary> {
    const [existing] = await this.d.db
      .select()
      .from(schema.secrets)
      .where(eq(schema.secrets.name, name));
    let row = existing ? await this.update(existing.id, value) : undefined;
    if (!row) {
      const id = randomUUID();
      try {
        [row] = await this.d.db
          .insert(schema.secrets)
          .values({ id, name, valueEnc: this.d.vault.seal(value, aad(id)) })
          .returning();
      } catch (err) {
        // A concurrent put created it first: update that row instead.
        if (!pgCode(err, "23505")) throw err;
        const [raced] = await this.d.db
          .select()
          .from(schema.secrets)
          .where(eq(schema.secrets.name, name));
        row = raced ? await this.update(raced.id, value) : undefined;
      }
    }
    if (!row) throw new Error("secret upsert returned no row");
    const users = await this.usedBy(name);
    await this.restartAll(users);
    return this.summary(row, users);
  }

  async remove(name: string): Promise<void> {
    const users = await this.usedBy(name);
    const deleted = await this.d.db
      .delete(schema.secrets)
      .where(eq(schema.secrets.name, name))
      .returning({ id: schema.secrets.id });
    if (!deleted.length) throw new ApiError(404, "secret_not_found", `No secret named ${name}.`);
    // A revoked (maybe leaked) value must leave live processes.
    await this.restartAll(users);
  }
}
