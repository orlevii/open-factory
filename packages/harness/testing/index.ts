import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type FakeSlice = { fixture: string; lines: [number, number] };
export type FakeStep = { emit: FakeSlice } | { sleep: number } | { longTool: number };
export interface FakeScenario {
  onStart?: FakeStep[];
  onUser: FakeStep[];
  onCompact?: FakeStep[];
  onInterrupt?: FakeStep[];
}
export type FakeLogEntry =
  | { kind: "start"; argv: string[]; env: Record<string, string>; pid: number }
  | { kind: "stdin"; line: string }
  | { kind: "exit"; code: number };

export interface FakeClaude {
  /** An executable to pass as claudeBin / FACTORY_CLAUDE_BIN. */
  bin: string;
  dir: string;
  stateDir: string;
  log(): FakeLogEntry[];
  /** Mark a session id as resumable (as if a previous run created it). */
  knownSession(id: string): void;
}

const FAKE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
const SCENARIOS = fileURLToPath(new URL("./scenarios/", import.meta.url));

/** Writes a wrapper script that sets the fake's config and execs it. The agent env is an allowlist,
 *  so config can't travel through the child env; the wrapper carries it instead. */
export function createFakeClaude(opts: {
  scenario: string | FakeScenario;
  dir?: string;
  /** Extra env the wrapper exports (the child env is an allowlist, so tests can't pass it directly). */
  env?: Record<string, string>;
}): FakeClaude {
  const dir = opts.dir ?? mkdtempSync(path.join(tmpdir(), "fake-claude-"));
  const stateDir = path.join(dir, "sessions");
  mkdirSync(stateDir, { recursive: true });
  const scenarioPath =
    typeof opts.scenario === "string"
      ? path.join(SCENARIOS, `${opts.scenario}.json`)
      : path.join(dir, "scenario.json");
  if (typeof opts.scenario !== "string") {
    writeFileSync(scenarioPath, JSON.stringify(opts.scenario));
  }
  const bin = path.join(dir, "claude");
  const extraEnv = Object.entries(opts.env ?? {})
    .map(([k, v]) => `export ${k}='${v.replaceAll("'", "'\\''")}'\n`)
    .join("");
  writeFileSync(
    bin,
    `#!/bin/sh\n${extraEnv}FAKE_CLAUDE_SCENARIO='${scenarioPath}' FAKE_CLAUDE_DIR='${dir}' exec '${process.execPath}' '${FAKE}' "$@"\n`,
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    dir,
    stateDir,
    log: () => {
      try {
        return readFileSync(path.join(dir, "log.jsonl"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
    knownSession: (id) => appendFileSync(path.join(stateDir, id), ""),
  };
}
export { FakeTransport } from "./fake-transport.ts";
