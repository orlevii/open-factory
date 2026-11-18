#!/usr/bin/env node
// Drive a live `claude -p --input-format stream-json` process through a list of steps
// and record every stdout line. Usage:
//   node drive.mjs <steps.json> <out-prefix> [-- extra claude args]
// Env: CLAUDE_CONFIG_DIR, cwd (SPIKE_CWD), CLAUDE_BIN (default "claude").
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, readFileSync } from "node:fs";

const [stepsPath, outPrefix, ...rest] = process.argv.slice(2);
const extra = rest[0] === "--" ? rest.slice(1) : rest;
const steps = JSON.parse(readFileSync(stepsPath, "utf8"));
const bin = process.env.CLAUDE_BIN ?? "claude";
const baseArgs = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
];
const t0 = Date.now();
const trace = createWriteStream(`${outPrefix}.jsonl`);
const timeline = createWriteStream(`${outPrefix}.timeline.log`);
const errlog = createWriteStream(`${outPrefix}.stderr.log`);
const log = (s) => timeline.write(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}\n`);

const child = spawn(bin, [...baseArgs, ...extra], {
  cwd: process.env.SPIKE_CWD ?? process.cwd(),
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});
log(`spawn pid=${child.pid} args=${extra.join(" ")}`);
const events = [];
const waiters = [];
let exited = null;
let buf = "";
child.stdout.on("data", (d) => {
  buf += d;
  for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    trace.write(`${line}\n`);
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      log(`non-json: ${line.slice(0, 200)}`);
      continue;
    }
    events.push(ev);
    const tools =
      ev.message?.content?.filter?.((c) => c.type === "tool_use").map((c) => c.name) ?? [];
    log(
      `<- ${ev.type}${ev.subtype ? `/${ev.subtype}` : ""}${tools.length ? ` tools=${tools}` : ""}`,
    );
    for (const w of [...waiters])
      if (w.match(ev)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(ev);
      }
  }
});
child.stderr.on("data", (d) => errlog.write(d));
const exitP = new Promise((r) =>
  child.on("exit", (code, sig) => {
    exited = { code, sig };
    log(`exit code=${code} sig=${sig}`);
    r(exited);
  }),
);

const matcher = (m) => (ev) =>
  (!m.type || ev.type === m.type) &&
  (!m.subtype || ev.subtype === m.subtype) &&
  (!m.tool || ev.message?.content?.some?.((c) => c.type === "tool_use" && c.name === m.tool)) &&
  (!m.text || JSON.stringify(ev).includes(m.text));
const waitFor = (m, timeout = 120000, fromIndex = 0) =>
  new Promise((resolve, reject) => {
    const match = matcher(m);
    const prior = events.slice(fromIndex).find(match);
    if (prior) return resolve(prior);
    const w = { match, resolve };
    waiters.push(w);
    setTimeout(() => {
      waiters.splice(waiters.indexOf(w), 1);
      reject(new Error(`timeout waiting ${JSON.stringify(m)}`));
    }, timeout);
  });
const write = (obj) => {
  log(`-> ${JSON.stringify(obj).slice(0, 160)}`);
  child.stdin.write(`${JSON.stringify(obj)}\n`);
};

let mark = 0;
for (const s of steps) {
  try {
    if (s.mark) mark = events.length;
    if (s.send !== undefined) write({ type: "user", message: { role: "user", content: s.send } });
    else if (s.raw) {
      if (typeof s.raw === "string") {
        log(`-> raw ${s.raw}`);
        child.stdin.write(`${s.raw}\n`);
      } else write(s.raw);
    } else if (s.control)
      write({ type: "control_request", request_id: randomUUID(), request: s.control });
    else if (s.waitFor) await waitFor(s.waitFor, s.timeout, s.since === "mark" ? mark : 0);
    else if (s.sleep) await new Promise((r) => setTimeout(r, s.sleep));
    else if (s.closeStdin) {
      log("close stdin");
      child.stdin.end();
    } else if (s.kill) {
      log(`kill ${s.kill}`);
      child.kill(s.kill);
    } else if (s.waitExit)
      await Promise.race([exitP, new Promise((r) => setTimeout(r, s.waitExit))]);
    else if (s.shell) {
      const { execSync } = await import("node:child_process");
      log(`shell: ${s.shell}\n${execSync(s.shell, { encoding: "utf8" })}`);
    }
  } catch (e) {
    log(`step error: ${e.message}`);
    if (!s.optional) break;
  }
}
if (!exited) {
  log("final: closing stdin");
  child.stdin.end();
  await Promise.race([exitP, new Promise((r) => setTimeout(r, 30000))]);
}
if (!exited) {
  log("final: SIGKILL");
  child.kill("SIGKILL");
  await exitP;
}
trace.end();
timeline.end();
errlog.end();
