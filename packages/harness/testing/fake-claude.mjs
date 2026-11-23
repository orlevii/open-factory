#!/usr/bin/env node
// Test double for `claude -p --input-format stream-json --output-format stream-json`.
// Replays slices of packages/harness/fixtures/*.jsonl. Config comes from env (set by the wrapper
// script that createFakeClaude writes): FAKE_CLAUDE_SCENARIO (path), FAKE_CLAUDE_DIR (log + state).
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

process.title = "claude";

const argv0 = process.argv.slice(2);
if (argv0[0] === "plugin") {
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  // Like Claude, apply `env` from the config-dir and project settings (S5 R1: that is how a planted
  // settings.json reached git), then emulate git honouring GIT_TRACE and a `!touch` credential helper.
  const readJson = (p) => {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return {};
    }
  };
  for (const p of [
    `${cfg}/settings.json`,
    `${process.cwd()}/.claude/settings.json`,
    `${process.cwd()}/.claude/settings.local.json`,
  ])
    Object.assign(process.env, readJson(p).env ?? {});
  if (process.env.GIT_TRACE?.startsWith("/")) appendFileSync(process.env.GIT_TRACE, "trace\n");
  for (let i = 0; i < Number(process.env.GIT_CONFIG_COUNT ?? 0); i++) {
    const helper = /^!touch (.+)$/.exec(process.env[`GIT_CONFIG_VALUE_${i}`] ?? "");
    if (process.env[`GIT_CONFIG_KEY_${i}`] === "credential.helper" && helper)
      writeFileSync(helper[1], "");
  }
  appendFileSync(
    `${process.env.FAKE_CLAUDE_DIR}/plugin.log`,
    `${JSON.stringify({ argv: argv0, env: Object.keys(process.env).sort(), cwd: process.cwd(), configDir: cfg })}\n`,
  );
  mkdirSync(`${cfg}/plugins`, { recursive: true });
  const f = `${cfg}/settings.json`;
  const s = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
  if (argv0[1] === "marketplace" && argv0[2] === "add") {
    const src = argv0[3];
    const name = src.split("/").pop();
    s.extraKnownMarketplaces = {
      ...s.extraKnownMarketplaces,
      [name]: { source: { source: "directory", path: src } },
    };
  } else if (argv0[1] === "install") {
    const ref = argv0[2];
    if ((process.env.FAKE_CLAUDE_PLUGIN_FAIL ?? "").split(",").includes(ref)) {
      process.stderr.write(
        `\u2718 Failed to install plugin "${ref}": Plugin not found in marketplace\n`,
      );
      // Extra failure output a test wants echoed (secret-shaped fixtures for the redaction tests).
      if (process.env.FAKE_CLAUDE_PLUGIN_ECHO)
        process.stderr.write(`${process.env.FAKE_CLAUDE_PLUGIN_ECHO}\n`);
      process.exit(1);
    }
    if (process.env.FAKE_CLAUDE_PLUGIN_SLEEP_MS)
      await new Promise((r) => setTimeout(r, Number(process.env.FAKE_CLAUDE_PLUGIN_SLEEP_MS)));
    s.enabledPlugins = { ...s.enabledPlugins, [ref]: true };
  }
  writeFileSync(f, JSON.stringify(s, null, 2));
  process.stdout.write("\u2714 ok\n");
  process.exit(0);
}

const FIXTURES = new URL("../fixtures/", import.meta.url);
const scenario = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_SCENARIO, "utf8"));
const dir = process.env.FAKE_CLAUDE_DIR;
const stateDir = `${dir}/sessions`;
mkdirSync(stateDir, { recursive: true });
const log = (entry) => appendFileSync(`${dir}/log.jsonl`, `${JSON.stringify(entry)}\n`);
const exit = (code) => {
  log({ kind: "exit", code });
  process.exit(code);
};
process.on("SIGTERM", () => exit(143));

const args = process.argv.slice(2);
log({ kind: "start", argv: args, env: process.env, pid: process.pid });
const resumeIdx = args.indexOf("--resume");
const resumeId = resumeIdx >= 0 ? args[resumeIdx + 1] : undefined;

const fixtureLines = (name) =>
  readFileSync(new URL(`${name}.jsonl`, FIXTURES), "utf8")
    .split("\n")
    .filter((l) => l.trim());
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let sessionId;
let stdinClosed = false;
let interrupt; // resolver for a running longTool
const work = []; // queued user lines
let busy = false;

function emit(slice) {
  const lines = fixtureLines(slice.fixture).slice(slice.lines[0] - 1, slice.lines[1]);
  for (const l of lines) {
    const obj = JSON.parse(l);
    if ("session_id" in obj) obj.session_id = sessionId;
    out(obj);
  }
}

async function runSteps(steps) {
  for (const step of steps ?? []) {
    if (step.emit) emit(step.emit);
    else if (step.sleep) await sleep(step.sleep);
    else if (step.longTool) {
      let timer;
      const interrupted = await Promise.race([
        new Promise((r) => {
          timer = setTimeout(() => r(false), step.longTool);
        }),
        new Promise((r) => {
          interrupt = () => r(true);
        }),
      ]);
      clearTimeout(timer);
      interrupt = undefined;
      if (interrupted) {
        await runSteps(scenario.onInterrupt);
        return;
      }
    }
  }
}

async function drain() {
  if (busy) return;
  busy = true;
  while (work.length) {
    const msg = work.shift();
    const content = typeof msg.message?.content === "string" ? msg.message.content : "";
    await runSteps(content.startsWith("/compact") ? scenario.onCompact : scenario.onUser);
  }
  busy = false;
  if (stdinClosed) exit(0);
}

async function main() {
  if (resumeId && !existsSync(`${stateDir}/${resumeId}`)) {
    const [line] = fixtureLines("error-resume-missing-session");
    const obj = JSON.parse(line);
    obj.session_id = resumeId;
    out(obj);
    process.stderr.write(`No conversation found with session ID: ${resumeId}\n`);
    process.stdin.on("end", () => exit(1));
    process.stdin.resume();
    return;
  }
  sessionId = resumeId ?? randomUUID();
  writeFileSync(`${stateDir}/${sessionId}`, "");
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    log({ kind: "stdin", line });
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stderr.write("Error parsing streaming input line\n");
      exit(1);
    }
    if (msg.type === "control_request" && msg.request?.subtype === "interrupt") {
      out({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: msg.request_id,
          response: { still_queued: [] },
        },
      });
      interrupt?.();
      return;
    }
    if (msg.type === "control_request" && msg.request?.subtype === "initialize") {
      // U3 §13.3: answered at once, no turn. The scenario's `commands` (none by default).
      out({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: msg.request_id,
          response: { commands: scenario.commands ?? [], claude_code_version: "2.1.327" },
        },
      });
      return;
    }
    if (msg.type === "user") {
      work.push(msg);
      void startup.then(drain);
    }
  });
  rl.on("close", () => {
    stdinClosed = true;
    startup.then(() => {
      if (!busy) exit(0);
    });
  });
  startup = runSteps(scenario.onStart);
}
let startup = Promise.resolve();
main();
