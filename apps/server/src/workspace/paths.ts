import path from "node:path";

export const agentWorkdir = (factoryHome: string, ref: string) =>
  path.join(factoryHome, "agents", ref);
export const agentConfigDir = (workdir: string) => path.join(workdir, ".claude-config");

/** Factory-owned per-agent state. Outside the workdir: the agent can't write it, and it is never mounted whole. */
export const agentStateDir = (factoryHome: string, ref: string) =>
  path.join(factoryHome, "state", "agents", ref);
/** Where Reset persona saves the AGENTS.md it replaces: `<stamp>/AGENTS.md` below this. */
export const personaRoot = (factoryHome: string, ref: string) =>
  path.join(agentStateDir(factoryHome, ref), "persona");
/** A reset staged while the agent may be running; `prepare` applies and removes it. */
export const personaPendingDir = (factoryHome: string, ref: string) =>
  path.join(agentStateDir(factoryHome, ref), "persona-pending");
