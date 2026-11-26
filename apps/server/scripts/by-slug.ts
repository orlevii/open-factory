import type { AgentRuntime } from "../src/agents/agent-runtime.ts";
import type { AgentRuntimes } from "../src/agents/runtimes.ts";

/** The smoke scripts name their agents by the handle they created them with; the runtimes are keyed by id. */
export async function bySlug(
  app: {
    store: { listAgents(): Promise<{ id: string; slug: string }[]> };
    runtimes: AgentRuntimes;
  },
  slug: string,
): Promise<AgentRuntime | undefined> {
  const row = (await app.store.listAgents()).find((a) => a.slug === slug);
  return row ? app.runtimes.load(row.id) : undefined;
}
