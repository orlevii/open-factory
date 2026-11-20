import type { AgentRuntimeSpec } from "../types.ts";

export function buildClaudeArgs(
  spec: AgentRuntimeSpec,
  opts: { resumeSessionId?: string },
): string[] {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
  ];
  if (spec.permissionMode === "bypass") args.push("--dangerously-skip-permissions");
  else args.push("--permission-mode", "auto");
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  if (spec.model) args.push("--model", spec.model);
  if (spec.effort) args.push("--effort", spec.effort);
  return args;
}
