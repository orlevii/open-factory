import { type AgentRow, type Db, schema } from "@open-factory/db";
import { and, asc, eq, isNull } from "drizzle-orm";

/** Who an agent can see: manager, peers (same manager; top-level agents are peers) and reports. Non-archived only. */
export class Neighborhood {
  constructor(private readonly db: Db) {}

  async of(agentId: string): Promise<{
    manager: AgentRow | null;
    peers: AgentRow[];
    reports: AgentRow[];
  }> {
    const [self] = await this.db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
    if (!self) return { manager: null, peers: [], reports: [] };
    const live = isNull(schema.agents.archivedAt);
    const order = [asc(schema.agents.displayName), asc(schema.agents.slug)] as const;
    const manager = self.reportsTo
      ? ((
          await this.db
            .select()
            .from(schema.agents)
            .where(and(eq(schema.agents.id, self.reportsTo), live))
        )[0] ?? null)
      : null;
    const sameManager = self.reportsTo
      ? eq(schema.agents.reportsTo, self.reportsTo)
      : isNull(schema.agents.reportsTo);
    const peers = (
      await this.db
        .select()
        .from(schema.agents)
        .where(and(sameManager, live))
        .orderBy(...order)
    ).filter((a) => a.id !== agentId);
    const reports = await this.db
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.reportsTo, agentId), live))
      .orderBy(...order);
    return { manager, peers, reports };
  }

  async all(): Promise<AgentRow[]> {
    return this.db
      .select()
      .from(schema.agents)
      .where(isNull(schema.agents.archivedAt))
      .orderBy(asc(schema.agents.displayName), asc(schema.agents.slug));
  }

  async humans(): Promise<{ handle: string; name: string }[]> {
    return this.db
      .select({ handle: schema.users.handle, name: schema.users.name })
      .from(schema.users)
      .orderBy(asc(schema.users.name), asc(schema.users.handle));
  }
}
