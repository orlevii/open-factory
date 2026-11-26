import { type Db, schema } from "@open-factory/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Exec } from "../agents/event-store.ts";
import {
  type AgentRecord,
  agentRecords,
  type Principal,
  principalsByIds,
} from "../principals/principal-store.ts";
import { tagLookupFor } from "../principals/principal-text.ts";

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
    manager: AgentRecord | null;
    peers: AgentRecord[];
    reports: AgentRecord[];
  }> {
    const [self] = await agentRecords(tx).where(eq(schema.agents.id, agentId));
    if (!self) return { manager: null, peers: [], reports: [] };
    const live = liveAgent;
    const order = [asc(schema.agents.displayName), asc(schema.principals.handle)] as const;
    // A human manager has no agent row: `manager` is null.
    const manager =
      (await agentRecords(tx).where(and(eq(schema.agents.id, self.reportsTo), live)))[0] ?? null;
    // Peers share the manager, an agent or a human.
    const sameManager = eq(schema.agents.reportsTo, self.reportsTo);
    const peers = (
      await agentRecords(tx)
        .where(and(sameManager, live))
        .orderBy(...order)
    ).filter((a) => a.id !== agentId);
    const reports = await agentRecords(tx)
      .where(and(eq(schema.agents.reportsTo, agentId), live))
      .orderBy(...order);
    return { manager, peers, reports };
  }

  async all(tx: Exec = this.db): Promise<AgentRecord[]> {
    return agentRecords(tx)
      .where(liveAgent)
      .orderBy(asc(schema.agents.displayName), asc(schema.principals.handle));
  }

  /** The principals of these agents (their ref and current handle), by id. */
  principalsOf(ids: readonly string[]): Promise<Map<string, Principal>> {
    return principalsByIds(this.db, ids);
  }

  /** For rendering stored text as an agent reads it: one query for every ref in `texts`. */
  tagLookup(texts: readonly string[]) {
    return tagLookupFor(this.db, texts);
  }

  async humans(): Promise<{ ref: string; handle: string; name: string }[]> {
    return this.db
      .select({
        ref: schema.principals.ref,
        handle: schema.principals.handle,
        name: schema.users.name,
      })
      .from(schema.users)
      .innerJoin(schema.principals, eq(schema.principals.id, schema.users.id))
      .where(isNull(schema.users.disabledAt))
      .orderBy(asc(schema.users.name), asc(schema.principals.handle));
  }
}
