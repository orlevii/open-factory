#!/usr/bin/env node
// Test double for `claude -p --input-format stream-json --output-format stream-json`.
// Replays slices of packages/harness/fixtures/*.jsonl. Config comes from env (set by the wrapper
// script that createFakeClaude writes): FAKE_CLAUDE_SCENARIO (path), FAKE_CLAUDE_DIR (log + state).
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argv0 = process.argv.slice(2);
if (argv0[0] === "plugin") {
  const {
    readFileSync: rf,
    writeFileSync: wf,
    existsSync: ex,
    mkdirSync: mk,
    appendFileSync: af,
  } = await import("node:fs");
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  af(
    `${process.env.FAKE_CLAUDE_DIR}/plugin.log`,
    `${JSON.stringify({ argv: argv0, env: Object.keys(process.env).sort() })}\n`,
  );
  mk(cfg, { recursive: true });
  const f = `${cfg}/settings.json`;
  const s = ex(f) ? JSON.parse(rf(f, "utf8")) : {};
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
      process.exit(1);
    }
    if (process.env.FAKE_CLAUDE_PLUGIN_SLEEP_MS)
      await new Promise((r) => setTimeout(r, Number(process.env.FAKE_CLAUDE_PLUGIN_SLEEP_MS)));
    s.enabledPlugins = { ...s.enabledPlugins, [ref]: true };
  }
  wf(f, JSON.stringify(s, null, 2));
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
