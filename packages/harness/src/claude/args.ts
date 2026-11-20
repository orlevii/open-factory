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
    "--permission-mode",
    spec.permissionMode,
  ];
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  if (spec.model) args.push("--model", spec.model);
  if (spec.effort) args.push("--effort", spec.effort);
  return args;
}
