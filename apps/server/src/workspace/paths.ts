import path from "node:path";

export const agentWorkdir = (factoryHome: string, slug: string) =>
  path.join(factoryHome, "agents", slug);
export const agentConfigDir = (workdir: string) => path.join(workdir, ".claude-config");

/** Factory-owned per-agent state. Outside the workdir: the agent can't write it, and it is never mounted whole. */
export const agentStateDir = (factoryHome: string, slug: string) =>
  path.join(factoryHome, "state", "agents", slug);
/** Where Reset persona saves the AGENTS.md it replaces: `<stamp>/AGENTS.md` below this. */
export const personaRoot = (factoryHome: string, slug: string) =>
  path.join(agentStateDir(factoryHome, slug), "persona");
/** A reset staged while the agent may be running; `prepare` applies and removes it. */
export const personaPendingDir = (factoryHome: string, slug: string) =>
  path.join(agentStateDir(factoryHome, slug), "persona-pending");
