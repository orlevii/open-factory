#!/usr/bin/env node
// Test double for `claude -p --input-format stream-json --output-format stream-json`.
// Replays slices of packages/harness/fixtures/*.jsonl. Config comes from env (set by the wrapper
// script that createFakeClaude writes): FAKE_CLAUDE_SCENARIO (path), FAKE_CLAUDE_DIR (log + state).
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

process.title = "claude";

const argv0 = process.argv.slice(2);
const VERSION = process.env.FAKE_CLAUDE_VERSION ?? "2.1.331";
if (argv0[0] === "--version") {
  process.stdout.write(`${VERSION} (Claude Code)\n`);
  process.exit(0);
}
if (argv0[0] === "setup-token") {
  const { SYNTHETIC_URL, SYNTHETIC_TOKEN } = await import("./synthetic-sign-in.mjs");
  if (process.env.FAKE_CLAUDE_DIR)
    writeFileSync(`${process.env.FAKE_CLAUDE_DIR}/setup-token.pid`, String(process.pid));
  if (!process.stdin.isTTY) {
    process.stderr.write("Raw mode is not supported\n");
    process.exit(1);
  }
  process.stdin.setRawMode(true); // before the prompt is written: a client may answer as soon as it sees it
  const ESC = "\x1b",
    cols = process.stdout.columns || 80;
  const cha = (words) => words.join(`${ESC}[9G`);
  process.stdout.write(
    `Welcome to Claude Code v0.0.0-fake\r\n\r\n${cha(["Browser", "didn't", "open?", "Use", "the", "url", "below", "to", "sign", "in", "(c", "to", "copy)"])}\r\n\r\n`,
  );
  process.stdout.write(
    `${ESC}]8;;${SYNTHETIC_URL}${ESC}\\${SYNTHETIC_URL.slice(0, cols - 1)}${ESC}]8;;${ESC}\\\r\n\r\n`,
  );
  process.stdout.write(
    "Hold Shift while selecting to use your terminal's native copy.\r\n\r\nPaste code here if prompted > ",
  );
  let buf = "";
  process.stdin.on("data", (d) => {
    const s = d.toString("utf8");
    if (s !== "\r") {
      buf += s;
      process.stdout.write("*".repeat(s.length));
      return;
    }
    process.stdin.pause();
    if (buf === "bad") {
      process.stdout.write("\r\nOAuth error: Invalid code\r\nPress Enter to retry.\r\n");
      buf = "";
      process.stdin.resume();
      return;
    }
    const done = () => {
      const lines = SYNTHETIC_TOKEN.match(new RegExp(`.{1,${cols}}`, "g")) ?? [];
      process.stdout.write(
        `\r\n\u2713 Long-lived authentication token created successfully!\r\n\rYour OAuth token (valid for 1 year):\r\r\n${lines.join("\r\n")}\r\rStore this token securely. You won't be able to see it again.\r\n`,
      );
      process.exit(0);
    };
    if (buf === "slow") setTimeout(done, 70_000);
    else done();
  });
  // A CLI that outlives a terminal hangup (only the group kill can stop it), for transport tests.
  if (process.env.FAKE_CLAUDE_STUBBORN) {
    process.on("SIGHUP", () => {});
    process.stdin.on("error", () => {});
    process.stdout.on("error", () => {});
    setInterval(() => {}, 60_000);
  } else process.stdin.on("end", () => process.exit(1));
  await new Promise(() => {}); // never falls through to the scenario code
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

async function startSession() {
  await runSteps(scenario.onStart);
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
          response: { commands: scenario.commands ?? [], claude_code_version: VERSION },
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
  startup = startSession();
}
let startup = Promise.resolve();
main();
