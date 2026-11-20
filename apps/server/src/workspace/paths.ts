import path from "node:path";

export const agentWorkdir = (factoryHome: string, slug: string) =>
  path.join(factoryHome, "agents", slug);
export const agentConfigDir = (workdir: string) => path.join(workdir, ".claude-config");

/** Factory-owned per-agent state. Outside the workdir: the agent can't write it, and it is never mounted whole. */
export const agentStateDir = (factoryHome: string, slug: string) =>
  path.join(factoryHome, "state", "agents", slug);
export const templateCopyDir = (factoryHome: string, slug: string) =>
  path.join(agentStateDir(factoryHome, slug), "template");
export const resyncRoot = (factoryHome: string, slug: string) =>
  path.join(agentStateDir(factoryHome, slug), "resync");
export const resyncPendingDir = (factoryHome: string, slug: string) =>
  path.join(agentStateDir(factoryHome, slug), "resync-pending");
export const pluginsConfigDir = (factoryHome: string, slug: string) =>
  path.join(agentStateDir(factoryHome, slug), "plugins-config");
