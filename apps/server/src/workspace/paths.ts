import path from "node:path";

export const agentWorkdir = (factoryHome: string, slug: string) =>
  path.join(factoryHome, "agents", slug);
export const agentConfigDir = (workdir: string) => path.join(workdir, ".claude-config");
export const templateCopyDir = (workdir: string) => path.join(workdir, ".factory", "template");
export const resyncRoot = (workdir: string) => path.join(workdir, ".factory", "resync");
