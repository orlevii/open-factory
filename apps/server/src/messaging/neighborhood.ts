import { type AgentRow, type Db, schema } from "@open-factory/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Exec } from "../agents/event-store.ts";

/** An agent that is neither archived nor terminated. */
export const liveAgent = and(isNull(schema.agents.archivedAt), isNull(schema.agents.terminatedAt));

/**
 * Who an agent can see: manager (an agent; a human manager is none of the agents), peers (same manager, agent or human) and reports. Live agents only. Reads
 * run in `tx` when given (S7 §5.7: inside a spawn or terminate transaction).
 */
export class Neighborhood {
  constructor(private readonly db: Db) {}

  async of(
    agentId: string,
    tx: Exec = this.db,
  ): Promise<{
    manager: AgentRow | null;
    peers: AgentRow[];
    reports: AgentRow[];
  }> {
    const [self] = await tx.select().from(schema.agents).where(eq(schema.agents.id, agentId));
    if (!self) return { manager: null, peers: [], reports: [] };
    const live = liveAgent;
    const order = [asc(schema.agents.displayName), asc(schema.agents.slug)] as const;
    // A human manager has no agent row: `manager` is null.
    const manager =
      (
        await tx
          .select()
          .from(schema.agents)
          .where(and(eq(schema.agents.id, self.reportsTo), live))
      )[0] ?? null;
    // Peers share the manager, an agent or a human.
    const sameManager = eq(schema.agents.reportsTo, self.reportsTo);
    const peers = (
      await tx
        .select()
        .from(schema.agents)
        .where(and(sameManager, live))
        .orderBy(...order)
    ).filter((a) => a.id !== agentId);
    const reports = await tx
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.reportsTo, agentId), live))
      .orderBy(...order);
    return { manager, peers, reports };
  }

  async all(tx: Exec = this.db): Promise<AgentRow[]> {
    return tx
      .select()
      .from(schema.agents)
      .where(liveAgent)
      .orderBy(asc(schema.agents.displayName), asc(schema.agents.slug));
  }

  async humans(): Promise<{ handle: string; name: string }[]> {
    return this.db
      .select({ handle: schema.principals.handle, name: schema.users.name })
      .from(schema.users)
      .innerJoin(schema.principals, eq(schema.principals.id, schema.users.id))
      .where(isNull(schema.users.disabledAt))
      .orderBy(asc(schema.users.name), asc(schema.principals.handle));
  }
}
