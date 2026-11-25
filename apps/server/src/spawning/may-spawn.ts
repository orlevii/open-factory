import type { AgentRow } from "@open-factory/db";
import type { TemplateConfig } from "@open-factory/shared";

/**
 * Whether an agent holds the spawn tools (spec §7.1): a live persistent agent with a template allowlist.
 * `config` is the effective config: `started` for the running process, the one being prepared at a start (spec §6.2).
 */
export const maySpawn = (
  a: Pick<AgentRow, "kind" | "archivedAt" | "terminatedAt">,
  config: Pick<TemplateConfig, "canSpawn">,
) => a.kind === "persistent" && !a.archivedAt && !a.terminatedAt && config.canSpawn.length > 0;
