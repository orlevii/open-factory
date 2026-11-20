import type { AgentRow } from "@open-factory/db";

/** Whether an agent holds the spawn tools (spec §7.1): a live persistent agent with a template allowlist and room. */
export const maySpawn = (a: Pick<AgentRow, "kind" | "archivedAt" | "terminatedAt" | "config">) =>
  a.kind === "persistent" &&
  !a.archivedAt &&
  !a.terminatedAt &&
  a.config.canSpawn.length > 0 &&
  a.config.maxLiveSpawns > 0;
