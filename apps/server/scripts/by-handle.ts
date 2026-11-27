import type { AgentRuntime } from "../src/agents/agent-runtime.ts";
import type { AgentRuntimes } from "../src/agents/runtimes.ts";

/** The smoke scripts name their agents by the handle they created them with; the runtimes are keyed by id. */
export async function byHandle(
  app: {
    store: { listAgents(): Promise<{ id: string; handle: string }[]> };
    runtimes: AgentRuntimes;
  },
  handle: string,
): Promise<AgentRuntime | undefined> {
  const row = (await app.store.listAgents()).find((a) => a.handle === handle);
  return row ? app.runtimes.load(row.id) : undefined;
}
