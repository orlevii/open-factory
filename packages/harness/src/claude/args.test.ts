import { expect, test } from "vitest";
import type { AgentRuntimeSpec } from "../types.ts";
import { buildClaudeArgs } from "./args.ts";

const spec = (p: Partial<AgentRuntimeSpec> = {}): AgentRuntimeSpec => ({
  agentId: "a",
  ref: "a",
  cwd: "/w",
  env: {},
  claudeBin: "claude",
  runtime: "local",
  permissionMode: "auto",
  mounts: [],
  ...p,
});

test("auto mode", () => {
  expect(
    buildClaudeArgs(spec({ model: "haiku", effort: "high" }), { resumeSessionId: "s1" }),
  ).toEqual([
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    "auto",
    "--resume",
    "s1",
    "--model",
    "haiku",
    "--effort",
    "high",
  ]);
  // no resume and no model: only the fixed flags
  expect(buildClaudeArgs(spec(), {})).toEqual([
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    "auto",
  ]);
});

test("bypass uses --dangerously-skip-permissions and no --permission-mode", () => {
  const a = buildClaudeArgs(spec({ permissionMode: "bypass" }), {});
  expect(a).toContain("--dangerously-skip-permissions");
  expect(a).not.toContain("--permission-mode");
  expect(a).toContain("--include-partial-messages");
});
