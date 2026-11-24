#!/usr/bin/env node
// Test double for `claude -p --input-format stream-json --output-format stream-json`.
// Replays slices of packages/harness/fixtures/*.jsonl. Config comes from env (set by the wrapper
// script that createFakeClaude writes): FAKE_CLAUDE_SCENARIO (path), FAKE_CLAUDE_DIR (log + state).
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
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
  await new Promise(() => {}); // never falls through to the plugin block or the scenario code
}
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
  // A failure that prints nothing (`marketplace` or `install`): the caller only has the exit to go on.
  if (process.env.FAKE_CLAUDE_PLUGIN_SILENT_FAIL === argv0[1]) process.exit(1);
  // The install failure knob still answers the factory's per-agent `plugin install` until B7 deletes its last callers.
  if (
    argv0[1] === "install" &&
    (process.env.FAKE_CLAUDE_PLUGIN_FAIL ?? "").split(",").includes(argv0[2])
  ) {
    process.stderr.write(
      `\u2718 Failed to install plugin "${argv0[2]}": Plugin not found in marketplace\n`,
    );
    // Extra failure output a test wants echoed (secret-shaped fixtures for the redaction tests).
    if (process.env.FAKE_CLAUDE_PLUGIN_ECHO)
      process.stderr.write(`${process.env.FAKE_CLAUDE_PLUGIN_ECHO}\n`);
    process.exit(1);
  }
  process.stderr.write("fake claude: plugin subcommands aren't used by Open Factory\n");
  process.exit(1);
}

// Session start (spec §7.3 steps 4-8): Claude Code reads `--settings` and installs each enabled plugin of a
// directory or git marketplace into CLAUDE_CODE_PLUGIN_CACHE_DIR, at the declared ref, before `init`.
const COMMIT = /^[0-9a-f]{40}$/;
// Claude Code refuses a commit pin on these names: they follow a branch or tag.
const RESERVED_MARKETPLACES = ["claude-plugins-official"];
const readJsonOr = (p, fallback) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
};
const git = (args, cwd) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

// The marketplace's checkout under the plugins root, with its commit (none for a directory). Null when Claude
// Code refuses the pin or the fetch fails: the plugins from it don't load.
function fetchMarketplace(cache, mkt, decl) {
  const src = decl.source ?? {};
  if (RESERVED_MARKETPLACES.includes(mkt) && COMMIT.test(src.ref ?? "")) return null;
  const dest = path.join(cache, "marketplaces", mkt);
  rmSync(dest, { recursive: true, force: true });
  try {
    if (src.source === "directory") {
      cpSync(src.path, dest, { recursive: true });
      return { root: dest, commit: undefined };
    }
    let url;
    if (src.source === "git") url = src.url;
    else if (src.source === "github" && process.env.FAKE_CLAUDE_GITHUB_URL)
      url = `${process.env.FAKE_CLAUDE_GITHUB_URL}/${src.repo}.git`;
    if (!url) return null;
    git(["clone", "--quiet", url, dest]);
    if (src.ref) git(["checkout", "--quiet", src.ref], dest);
    return { root: dest, commit: git(["rev-parse", "HEAD"], dest) };
  } catch {
    return null;
  }
}

// Installs what `settings` enables and returns the `init.plugins` entries of the plugins that are loaded.
function installSessionPlugins(settings) {
  const cache = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
  const declared = settings.extraKnownMarketplaces ?? {};
  const installedFile = path.join(cache, "installed_plugins.json");
  const knownFile = path.join(cache, "known_marketplaces.json");
  const installed = readJsonOr(installedFile, { version: 2, plugins: {} });
  const known = readJsonOr(knownFile, {});
  const markets = new Map();
  const loaded = [];
  const now = new Date().toISOString();
  for (const [key, on] of Object.entries(settings.enabledPlugins ?? {})) {
    if (on !== true) continue;
    const at = key.lastIndexOf("@");
    const name = key.slice(0, at);
    const mkt = key.slice(at + 1);
    if (!declared[mkt]) continue;
    if (!markets.has(mkt)) markets.set(mkt, fetchMarketplace(cache, mkt, declared[mkt]));
    const m = markets.get(mkt);
    if (!m) continue;
    known[mkt] = {
      source: declared[mkt].source,
      installLocation: m.root,
      lastUpdated: now,
      autoUpdate: declared[mkt].autoUpdate ?? false,
    };
    const catalog = readJsonOr(path.join(m.root, ".claude-plugin", "marketplace.json"), {});
    const entry = catalog.plugins?.find((p) => p.name === name);
    if (typeof entry?.source !== "string" || !entry.source.startsWith("./")) continue;
    const srcDir = path.join(m.root, entry.source);
    const manifest = readJsonOr(path.join(srcDir, ".claude-plugin", "plugin.json"), {});
    const version = manifest.version ?? entry.version ?? "unknown";
    const installPath = path.join(cache, "cache", mkt, name, version);
    const current = installed.plugins[key]?.[0];
    const sameCommit =
      current !== undefined &&
      current.installPath === installPath &&
      current.gitCommitSha === m.commit &&
      existsSync(installPath);
    if (!sameCommit) {
      rmSync(installPath, { recursive: true, force: true });
      mkdirSync(path.dirname(installPath), { recursive: true });
      cpSync(srcDir, installPath, {
        recursive: true,
        filter: (f) => path.basename(f) !== ".git",
      });
      installed.plugins[key] = [
        {
          scope: "user",
          installPath,
          version,
          installedAt: now,
          lastUpdated: now,
          ...(m.commit ? { gitCommitSha: m.commit } : {}),
        },
      ];
      appendFileSync(
        `${process.env.FAKE_CLAUDE_DIR}/plugin.log`,
        `install ${key} ${m.commit ?? "-"} ${installPath}\n`,
      );
    }
    loaded.push({ name, path: installPath, source: key, version });
  }
  mkdirSync(cache, { recursive: true });
  writeFileSync(installedFile, JSON.stringify(installed, null, 2));
  writeFileSync(knownFile, JSON.stringify(known, null, 2));
  return loaded;
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
    if (sessionSettings && obj.type === "system" && obj.subtype === "init")
      obj.plugins = loadedPlugins ?? [];
    out(obj);
  }
}

// The session start's plugin installs, once `--settings` is given (the fixture's `init` then lists what loaded).
const settingsIdx = args.indexOf("--settings");
const sessionSettings = settingsIdx >= 0 ? JSON.parse(args[settingsIdx + 1]) : undefined;
let loadedPlugins;
async function startSession() {
  const pluginScenario = process.env.FAKE_CLAUDE_PLUGIN_SCENARIO;
  const install = async () => {
    if (!sessionSettings) return;
    if (pluginScenario === "slow")
      await sleep(Number(process.env.FAKE_CLAUDE_PLUGIN_SLEEP_MS ?? 0));
    loadedPlugins = pluginScenario === "install-fail" ? [] : installSessionPlugins(sessionSettings);
  };
  // `late`: init goes out before the installs, as Claude Code does with a remote marketplace (G1 item 8).
  if (pluginScenario === "late") {
    await runSteps(scenario.onStart);
    await install();
  } else {
    await install();
    await runSteps(scenario.onStart);
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
