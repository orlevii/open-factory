import type { AgentRow } from "@open-factory/db";
import { describeChanges } from "@open-factory/shared";
import type { ConfigResolver } from "./config-resolver.ts";
import type { AgentRuntimes } from "./runtimes.ts";

/**
 * The config lines a restart applies (I7 §9.2): `describeChanges(started, effective)`, `[]` when nothing started. The
 * caller computes it outside the runtime's job, because the resolver reads the disk. It is `null` when the resolver
 * fails (a broken template): the restart still goes ahead, and its start then fails closed.
 */
export async function restartChanges(
  d: { runtimes: Pick<AgentRuntimes, "startedOf">; resolver: Pick<ConfigResolver, "effective"> },
  row: AgentRow,
): Promise<string[] | null> {
  const started = d.runtimes.startedOf(row.id);
  try {
    const now = await d.resolver.effective(row);
    return started ? describeChanges(started, now) : [];
  } catch {
    return null;
  }
}
