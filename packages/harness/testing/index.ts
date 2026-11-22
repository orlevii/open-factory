import {
  appendFileSync,
  chmodSync,
  cpSync,
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
  /** What `initialize` answers with (U3 §13.3); none by default. */
  commands?: { name: string; description: string; argumentHint: string; builtin?: boolean }[];
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
    log: () => readLog(dir),
    knownSession: (id) => appendFileSync(path.join(stateDir, id), ""),
  };
}
const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

/** Where `installFakeClaude` puts the fake inside a workdir (known before the workdir exists). */
export const fakeClaudeIn = (workdir: string) => {
  const root = path.join(workdir, ".fake-claude");
  return {
    root,
    // The fake reads its fixtures from `../fixtures/` relative to itself: the layout mirrors this package.
    bin: path.join(root, "testing", "fake-claude.mjs"),
    fixtures: path.join(root, "fixtures"),
    scenario: path.join(root, "scenario.json"),
    dir: path.join(root, "run"),
  };
};

export interface WorkdirFakeClaude {
  /** The fake's path, for `FACTORY_DOCKER_CLAUDE_BIN`: the same inside the container (path parity). */
  bin: string;
  /** `FAKE_CLAUDE_DIR`: the fake's log and session state. */
  dir: string;
  /** The fake's settings, to define as factory secrets and list in the template's `secrets`. */
  secrets: { FAKE_CLAUDE_SCENARIO: string; FAKE_CLAUDE_DIR: string };
  log(): FakeLogEntry[];
}

/**
 * Copies the fake claude and the fixtures it replays into a Docker agent's workdir. The workdir is already a checked
 * read-write mount at path parity, so the fake reaches the container through the real mounts, and its settings
 * travel as secrets through `buildAgentEnv` (no wrapper with baked-in host paths). It runs on the image's Node.
 */
export function installFakeClaude(opts: {
  workdir: string;
  scenario: string | FakeScenario;
}): WorkdirFakeClaude {
  const p = fakeClaudeIn(opts.workdir);
  mkdirSync(path.dirname(p.bin), { recursive: true });
  mkdirSync(path.join(p.dir, "sessions"), { recursive: true });
  cpSync(FAKE, p.bin);
  chmodSync(p.bin, 0o755);
  cpSync(FIXTURES, p.fixtures, { recursive: true });
  writeFileSync(
    p.scenario,
    typeof opts.scenario === "string"
      ? readFileSync(path.join(SCENARIOS, `${opts.scenario}.json`), "utf8")
      : JSON.stringify(opts.scenario),
  );
  return {
    bin: p.bin,
    dir: p.dir,
    secrets: { FAKE_CLAUDE_SCENARIO: p.scenario, FAKE_CLAUDE_DIR: p.dir },
    log: () => readLog(p.dir),
  };
}

function readLog(dir: string): FakeLogEntry[] {
  try {
    return readFileSync(path.join(dir, "log.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export { FakeTransport } from "./fake-transport.ts";
