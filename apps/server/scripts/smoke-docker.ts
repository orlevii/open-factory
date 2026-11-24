// Live Docker check for S5 (spec §18.5). Not part of `pnpm test`.
// Needs Postgres (pnpm compose up -d), Docker with the local image open-factory-base:dev, a real `claude` on the
// host PATH (credential verification and the plugin install run there), the CLI bundle (pnpm build) and the
// OAuth token in ~/.open-factory-spike/oauth-token. The token is read from that file at run time into a factory
// credential and is never printed: everything this script prints goes through `redact`.
// Uses a throwaway database, a temp FACTORY_HOME, a temp git repo and a temp directory marketplace; the server
// listens on 127.0.0.1 (Docker Desktop reaches it at host.docker.internal; on plain Linux set HOST per the README).
// Model: haiku. Warm window: 1 minute.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net, { type AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { createDb, MIGRATIONS_DIR, migrate } from "@open-factory/db";
import { createTestDatabase } from "@open-factory/db/testing";
import type { AnyEvent, SessionEvent } from "@open-factory/shared";
import Docker from "dockerode";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { dockerodeClient } from "../src/runtime/docker/client.ts";
import { containerName, LABEL_AGENT_ID } from "../src/runtime/docker/containers.ts";
import { claimTestHandle } from "../src/test/handles.ts";
import { agentWorkdir } from "../src/workspace/paths.ts";

const IMAGE = "open-factory-base:dev";
const SLUG = "smoke-dock";
const TOKEN_FILE = path.join(homedir(), ".open-factory-spike", "oauth-token");

let token = "";
try {
  token = readFileSync(TOKEN_FILE, "utf8").trim();
} catch {}
if (!token) {
  console.error(`No OAuth token in ${TOKEN_FILE}.`);
  process.exit(1);
}

// ---------- output (always redacted) ----------
const redact = (s: string) =>
  s
    .split(token)
    .join("[redacted]")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]");
const say = (s: string) => console.log(redact(s));
let failures = 0;
const ok = (name: string, detail?: string) => say(`✔ ${name}${detail ? `\n    ${detail}` : ""}`);
const fail = (name: string, detail?: string) => {
  failures++;
  say(`✘ ${name}${detail ? `\n    ${detail}` : ""}`);
};
/** Prints the evidence on a pass too: the PR keeps this output. */
const check = (name: string, cond: boolean, detail?: string) =>
  cond ? ok(name, detail) : fail(name, detail);
class StopRun extends Error {}
/** A required step: on a throw it prints ✘ and stops the run (later steps depend on it). */
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    const r = await fn();
    ok(name);
    return r;
  } catch (err) {
    fail(name, err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    throw new StopRun();
  }
}
/** Required checks: stop the run when one fails, since the next steps build on it. */
const must = (name: string, cond: boolean, detail?: string) => {
  check(name, cond, detail);
  if (!cond) throw new StopRun();
};

// ---------- temp dirs ----------
// realpath: macOS tmpdir is a /var symlink; the factory works with canonical paths (spec §10).
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "of-smoke-docker-")));
const factoryHome = path.join(root, "home");
const hostClaudeDir = path.join(root, "host-claude");
const hostSkillsDir = path.join(hostClaudeDir, "skills");
const repoDir = path.join(root, "smoke-repo");
const marketDir = path.join(root, "smoke-market");
const WORD = `OSPREY-${randomBytes(3).toString("hex").toUpperCase()}`;
const HERON_FACT = "HERON-DOCKER-OK";

// ---------- system/init capture and warnings from the server log (pino JSON lines, never printed raw) ----------
interface Init {
  skills: string[];
  plugins: unknown[];
  cwd: string;
}
const inits: Init[] = [];
const serverWarnings: string[] = [];
const logStream = new Writable({
  write(chunk, _enc, cb) {
    for (const raw of String(chunk).split("\n")) {
      if (!raw.trim()) continue;
      try {
        const o = JSON.parse(raw) as {
          level?: number;
          line?: unknown;
          msg?: unknown;
          err?: unknown;
        };
        if (typeof o.line === "string" && o.line.includes('"subtype":"init"')) {
          const j = JSON.parse(o.line);
          if (j.type === "system" && j.subtype === "init")
            inits.push({
              skills: Array.isArray(j.skills) ? j.skills.map(String) : [],
              plugins: Array.isArray(j.plugins) ? j.plugins : [],
              cwd: String(j.cwd ?? ""),
            });
        }
        if ((o.level ?? 0) >= 40)
          serverWarnings.push(
            redact(`${o.msg ?? ""} ${o.err ? JSON.stringify(o.err).slice(0, 400) : ""}`),
          );
      } catch {}
    }
    cb();
  },
});

// ---------- app and cleanup ----------
let app!: Awaited<ReturnType<typeof buildApp>>;
let appBuilt = false;
let agentId = "";
let tdb: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
let closeDb: (() => Promise<void>) | undefined;
let cleaned: Promise<void> | undefined;
const dk = new Docker();
const client = dockerodeClient();

function cleanup(): Promise<void> {
  cleaned ??= (async () => {
    if (appBuilt) {
      let closeErr = "";
      await app.close().catch((e) => {
        closeErr = String(e);
      });
      if (closeErr) fail("cleanup: closing the app failed", closeErr);
    }
    // Throwaway agent: remove its container (by label, so only this run's agent is touched).
    if (agentId) {
      try {
        const listed = await dk.listContainers({
          all: true,
          filters: { label: [`${LABEL_AGENT_ID}=${agentId}`] },
        });
        for (const c of listed) await dk.getContainer(c.Id).remove({ force: true });
      } catch (e) {
        console.error(redact(`cleanup: removing the container failed: ${e}`));
      }
    }
    try {
      await closeDb?.();
    } catch (e) {
      console.error(`cleanup: closing the db pool failed: ${e}`);
    }
    try {
      await tdb?.drop();
    } catch (e) {
      console.error(`cleanup: dropping the throwaway database failed: ${e}`);
    }
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (e) {
      console.error(`cleanup: removing ${root} failed: ${e}`);
    }
  })();
  return cleaned;
}
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    console.error(`\n${sig}: cleaning up`);
    cleanup().finally(() => process.exit(130));
  });

// ---------- helpers ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const brief = (s: string, n = 300) => redact(s.replace(/\s+/g, " ").slice(0, n));
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });

const all = async (): Promise<SessionEvent[]> => app.store.after(agentId, 0, 10_000);
const since = async (seq: number): Promise<SessionEvent[]> => app.store.after(agentId, seq, 10_000);
const lastSeq = async () => (await all()).at(-1)?.seq ?? 0;
const evs = (list: SessionEvent[]) => list.map((e) => e.event as AnyEvent);
const textOf = (es: AnyEvent[]) =>
  es.flatMap((e) => (e.type === "assistant_text" ? [e.text] : [])).join("\n");
const toolTrace = (es: AnyEvent[]) =>
  es
    .flatMap((e) =>
      e.type === "tool_call"
        ? [`${e.name}(${brief(JSON.stringify(e.input), 160)})`]
        : e.type === "tool_result"
          ? [`→${e.isError ? " ERROR" : ""} ${brief(e.content, 160)}`]
          : [],
    )
    .join(" | ");
const lifecycle = (es: AnyEvent[]) =>
  es
    .filter((e) =>
      [
        "process_started",
        "container",
        "exited",
        "cleanup",
        "hibernated",
        "background_work_lost",
        "error",
        "stop_escalated",
      ].includes(e.type),
    )
    .map((e) => brief(JSON.stringify(e), 200))
    .join("\n    ");

async function until<T>(
  what: string,
  fn: () => Promise<T | undefined | false>,
  ms: number,
  every = 500,
): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await fn();
    if (r) return r;
    await sleep(every);
  }
  throw new Error(`timed out after ${Math.round(ms / 1000)} s waiting for ${what}`);
}

/** Sends a human message and waits for the turn it starts (the first origin-less turn_end after it). */
async function turn(body: string, ms = 240_000): Promise<{ from: number; events: AnyEvent[] }> {
  const from = await lastSeq();
  const rt = await app.runtimes.bySlug(SLUG);
  if (!rt) throw new Error(`no runtime for ${SLUG}`);
  const [sent] = (await app.router.send({ userId: "smoke", handle: "smoke" }, [SLUG], body, false))
    .results;
  if (!sent || sent.status === "refused" || sent.status === "start_failed")
    throw new Error(
      `send to ${SLUG} failed: ${sent?.status === "refused" ? sent.reason : sent?.note}`,
    );
  const got = await until(
    "the turn to end",
    async () => {
      const es = evs(await since(from));
      const err = es.find((e) => e.type === "error" && e.source !== "api");
      if (err) throw new Error(`start failed: ${brief(JSON.stringify(err))}`);
      return es.some((e) => e.type === "turn_end" && !e.originKind) ? es : undefined;
    },
    ms,
  );
  return { from, events: got };
}

const inspect = () => dk.getContainer(containerName(SLUG, agentId)).inspect();
const exec = async (cmd: string[], user = "agent") =>
  client.execRun((await inspect()).Id, { cmd, user });
/** pid, comm, start time (clock ticks since boot: shared with the host kernel) and command line. */
const LIST_PROCS = [
  "for p in /proc/[0-9]*; do",
  'printf "%s\\t%s\\t%s\\t%s\\n" "$(basename $p)" "$(cat $p/comm 2>/dev/null)"',
  '"$(cut -d" " -f22 $p/stat 2>/dev/null)" "$(tr "\\0" " " < $p/cmdline 2>/dev/null)"; done',
].join(" ");
async function procs() {
  const r = await exec(["sh", "-c", LIST_PROCS], "root");
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [pid, comm, start, cmd] = l.split("\t");
      return { pid: Number(pid), comm: comm ?? "", start: start ?? "", cmd: (cmd ?? "").trim() };
    });
}

function writeTemplate(name: string, files: Record<string, string>) {
  const dir = path.join(factoryHome, "templates", name);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
}

try {
  // 0. Setup (inside the try so a failure here still cleans up).
  const port = await freePort();
  tdb = await createTestDatabase();
  await migrate(tdb.url, MIGRATIONS_DIR);
  const config = loadConfig({
    ...process.env,
    DATABASE_URL: tdb.url,
    FACTORY_SECRET_KEY: "s".repeat(40),
    FACTORY_HOME: factoryHome,
    FACTORY_HOST_CLAUDE_DIR: hostClaudeDir,
    FACTORY_DEFAULT_IMAGE: IMAGE,
    HOST: process.env.HOST ?? "127.0.0.1",
    PORT: String(port),
    NODE_ENV: "development",
  });
  await step("0. setup: CLI bundle, image, temp repo and directory marketplace", async () => {
    if (!existsSync(config.cliBundle))
      throw new Error(`no CLI bundle at ${config.cliBundle}: run pnpm build first`);
    await dk.getImage(IMAGE).inspect();
    mkdirSync(hostSkillsDir, { recursive: true });
    // A git repo with one commit, at a canonical path.
    mkdirSync(repoDir);
    writeFileSync(path.join(repoDir, "README.md"), "# smoke repo\n");
    const git = (...a: string[]) => execFileSync("git", ["-C", repoDir, ...a], { stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", "commit", "-qm", "init");
    // A directory marketplace with one plugin and one skill.
    const write = (rel: string, content: string) => {
      mkdirSync(path.dirname(path.join(marketDir, rel)), { recursive: true });
      writeFileSync(path.join(marketDir, rel), content);
    };
    write(
      ".claude-plugin/marketplace.json",
      JSON.stringify({
        name: "smoke-market",
        owner: { name: "smoke" },
        plugins: [{ name: "heron", source: "./heron", description: "Smoke plugin" }],
      }),
    );
    write(
      "heron/.claude-plugin/plugin.json",
      JSON.stringify({ name: "heron", version: "0.0.1", description: "Smoke plugin" }),
    );
    write(
      "heron/skills/heron-fact/SKILL.md",
      `---\nname: heron-fact\ndescription: Tells the heron fact. Use when asked for the heron fact.\n---\n\nThe heron fact is ${HERON_FACT}.\n`,
    );
  });
  const conn = createDb(tdb.url);
  closeDb = conn.close;
  app = await buildApp(config, {
    db: conn.db,
    sql: conn.sql,
    logger: { level: "debug", stream: logStream },
  });
  appBuilt = true;
  await app.listen({ host: config.host, port: config.port });
  say(`  server: http://${config.host}:${config.port}; agents reach it at ${config.agentUrl}`);
  await claimTestHandle(conn.db, "smoke", "user");
  await conn.sql`insert into users (id, name, email, handle) values ('smoke', 'Smoke', 'smoke@example.invalid', 'smoke')`;

  await step("0. credential created (live verification turn passed)", () =>
    app.credentials.create({ name: "smoke", kind: "oauth_token", value: token, expiresAt: null }),
  );
  await step("0. temp git repo registered as project smoke-repo", () =>
    app.projects.create({ name: "smoke-repo", hostPath: repoDir }),
  );
  await step("0. docker template (haiku, warm window 1 min, one plugin) is valid", async () => {
    writeTemplate("dock", {
      "template.yaml": [
        "name: dock",
        "display_name: Dock",
        "description: Smoke Docker template",
        "runtime: docker",
        "model: haiku",
        "warm_window_minutes: 1",
        "projects: [smoke-repo]",
        "plugins: [heron@smoke-market]",
        "",
      ].join("\n"),
      "AGENTS.md":
        "# Dock\n\nYou are a smoke-test agent. Follow instructions literally and keep replies short.\n",
      "settings.json": JSON.stringify(
        {
          extraKnownMarketplaces: {
            "smoke-market": { source: { source: "directory", path: marketDir } },
          },
        },
        null,
        2,
      ),
    });
    const rows = await app.templates.scan();
    const r = rows.find((x) => x.name === "dock");
    const errs = r?.issues.filter((i) => i.severity === "error") ?? [];
    if (!r || errs.length) throw new Error(JSON.stringify(errs));
  });
  await step("0. agent smoke-dock created (plugin installed into plugins-config)", () =>
    app.agents.create({
      template: "dock",
      slug: SLUG,
      displayName: "Smoke Dock",
      description: "Smoke Docker agent",
      reportsTo: null,
      credential: "smoke",
    }),
  );
  agentId = String((await conn.sql`select id from agents where slug = ${SLUG}`)[0]?.id ?? "");
  const workdir = agentWorkdir(config.factoryHome, SLUG);

  // 1. Remember a word, list the plugin skill.
  const t1 = await step("1. first turn (container created, real claude in it) completes", () =>
    turn(
      [
        `Remember this word for later: ${WORD}. Keep it in this conversation only: do not write it to any file or memory.`,
        "Then do two things: 1) use the heron-fact skill and say the heron fact;",
        "2) list the names of the skills you have that come from plugins.",
      ].join("\n"),
    ),
  );
  const created = t1.events.find((e) => e.type === "container");
  check(
    "1. container created from open-factory-base:dev",
    created?.type === "container" && created.action === "created" && created.image === IMAGE,
    brief(JSON.stringify(created)),
  );
  const init = inits.at(-1);
  check(
    "1. system/init lists the heron plugin and its skill, cwd = the workdir",
    Boolean(init) &&
      JSON.stringify(init?.plugins).includes("heron") &&
      (init?.skills ?? []).some((s) => s.includes("heron-fact")) &&
      init?.cwd === workdir,
    `plugins: ${brief(JSON.stringify(init?.plugins ?? []))}; heron skills: ${(init?.skills ?? []).filter((s) => s.includes("heron")).join(", ")}; cwd: ${init?.cwd}`,
  );
  const t1Text = textOf(t1.events);
  check(
    "1. reply says the heron fact and names the heron-fact skill",
    t1Text.includes(HERON_FACT) && t1Text.includes("heron-fact"),
    `reply: ${brief(t1Text)}`,
  );
  // AC1 must prove the resumed session, not a file: nothing outside the conversation may hold the word.
  // The agent's own send_message reply is conversation (since S6 a reply goes through it), so it is not a leak.
  const t1Writes = t1.events.filter(
    (e) =>
      e.type === "tool_call" &&
      !e.name.endsWith("send_message") &&
      JSON.stringify(e.input).includes(WORD),
  );
  check(
    "1. the word was not written anywhere (no tool call carries it)",
    t1Writes.length === 0,
    `tools: ${toolTrace(t1.events) || "none"}`,
  );

  // 2. Hibernate after the 1-minute warm window; the container is stopped (kept).
  const hib = await step("2. hibernates after the warm window (≤ 3 min)", () =>
    until(
      "hibernated{warm_window}",
      async () =>
        evs(await since(t1.from)).find(
          (e) => e.type === "hibernated" && e.reason === "warm_window",
        ),
      180_000,
      1000,
    ),
  );
  say(`    ${brief(JSON.stringify(hib))}`);
  const afterHib = await inspect();
  check(
    "2. container stopped, not removed",
    afterHib.State.Running === false,
    `state: ${afterHib.State.Status}; id ${afterHib.Id.slice(0, 12)}`,
  );
  const status2 = (await app.runtimes.bySlug(SLUG))?.live().status;
  check("2. status hibernated", status2 === "hibernated", `status: ${status2}`);

  // 3. AC1: a message wakes it; it recalls the word.
  const t3 = await step("3. message wakes the agent and the turn completes", () =>
    turn("What is the word I asked you to remember earlier? Reply with only that word."),
  );
  const ps3 = t3.events.find((e) => e.type === "process_started");
  const c3 = t3.events.find((e) => e.type === "container");
  check(
    "3. container started again (same container) and the session resumed",
    c3?.type === "container" &&
      c3.action === "started" &&
      ps3?.type === "process_started" &&
      ps3.resumed === true &&
      (await inspect()).Id === afterHib.Id,
    `${brief(JSON.stringify(c3))}; ${brief(JSON.stringify(ps3))}`,
  );
  const t3Text = textOf(t3.events);
  check(
    "3. AC1: recalls the word from before hibernation",
    t3Text.includes(WORD),
    `reply: ${brief(t3Text)}`,
  );

  // 4. AC5: a file in the granted repo and a worktree; owner and `git worktree list` parity.
  // In the agent's own worktree: the factory's CLAUDE.md tells agents not to change the main checkout.
  const wt = path.join(repoDir, ".worktrees", "smoke-wt");
  const ownedFile = path.join(wt, "smoke-owned.txt");
  const t4 = await step(
    "4. agent creates a worktree in the granted repo and writes a file in it",
    () =>
      turn(
        [
          "Run this one Bash command exactly as written, in a single Bash call, then reply DONE:",
          `git -C ${repoDir} worktree add -q -b smoke-wt ${wt} && echo SMOKE-OWNED > ${ownedFile}`,
        ].join("\n"),
      ),
  );
  const uid = process.getuid?.() ?? -1;
  const gid = process.getgid?.() ?? -1;
  say(`    tools: ${toolTrace(t4.events)}`);
  say(`    reply: ${brief(textOf(t4.events))}`);
  say(
    `    events: ${t4.events.map((e) => (e.type === "turn_end" ? `turn_end(${JSON.stringify(e)})` : e.type)).join(", ")}`,
  );
  const fst = existsSync(ownedFile) ? statSync(ownedFile) : undefined;
  check(
    "4. AC5: host stat owner of the agent's file = id -u (and the group = id -g)",
    fst?.uid === uid && fst?.gid === gid,
    `file uid:gid ${fst?.uid}:${fst?.gid}; host id -u:-g ${uid}:${gid}`,
  );
  const inUid = (await exec(["stat", "-c", "%u:%g", ownedFile])).stdout.trim();
  const ctrUid = (await exec(["id", "-u"])).stdout.trim();
  check(
    "4. AC5: in the container the file is owned by the host uid and the agent user is the host uid",
    inUid === `${uid}:${gid}` && ctrUid === String(uid),
    `container stat ${inUid}; container id -u ${ctrUid}`,
  );
  const hostList = execFileSync("git", ["-C", repoDir, "worktree", "list"]).toString();
  const ctrList = (await exec(["git", "-C", repoDir, "worktree", "list"])).stdout;
  check(
    "4. AC5: git worktree list is the same on the host and in the container",
    hostList === ctrList && hostList.includes(wt),
    `host:\n      ${hostList.trim().split("\n").join("\n      ")}\n    container:\n      ${ctrList.trim().split("\n").join("\n      ")}`,
  );

  // 5. AC2: a background `sleep 600` keeps the agent awake past the warm window.
  const t5 = await step("5. agent starts a background sleep 600", () =>
    turn(
      [
        "Start this exact Bash command in the background (Bash tool with run_in_background: true): sleep 600",
        "Use the description 'sleep 600'. Do not wait for it, do not check on it, do not stop it.",
        "Reply STARTED as soon as it is running.",
      ].join("\n"),
    ),
  );
  const bgStarted = t5.events.find((e) => e.type === "background_task_started");
  must(
    "5. background_task_started for the sleep",
    bgStarted?.type === "background_task_started",
    `${brief(JSON.stringify(bgStarted))}; tools: ${toolTrace(t5.events)}`,
  );
  const waitFrom = await lastSeq();
  const waitStart = Date.now();
  say("    waiting 80 s (warm window 60 s + 20 s)…");
  await sleep(80_000);
  const rt5 = await app.runtimes.bySlug(SLUG);
  const live5 = rt5?.live();
  const hib5 = evs(await since(waitFrom)).filter((e) => e.type === "hibernated");
  const sleepTasks = (live5?.waitingOn.tasks ?? []).filter((t) =>
    /sleep/i.test(t.description ?? ""),
  );
  const running5 = (await inspect()).State.Running;
  check(
    `5. AC2: still running ${Math.round((Date.now() - waitStart) / 1000)} s later (no hibernate), waiting on the sleep`,
    hib5.length === 0 &&
      live5?.status !== "hibernated" &&
      running5 === true &&
      sleepTasks.length === 1,
    `status: ${live5?.status}; container running: ${running5}; hibernated events: ${hib5.length}; waitingOn: ${brief(JSON.stringify(live5?.waitingOn))}`,
  );
  const sleepProc = (await procs()).find((p) => p.cmd === "sleep 600");
  must(
    "5. the sleep 600 runs in the container",
    Boolean(sleepProc),
    brief(JSON.stringify(sleepProc)),
  );

  // 6. The factory is reachable from the container (spec §11.6). Since the messaging work OPEN_FACTORY_URL names the
  // agent listener, whose /api/status answers the version only (no database check).
  const curl = await exec(["curl", "-s", "--max-time", "10", `${config.agentUrl}/api/status`]);
  let statusBody: { version?: unknown; db?: unknown } = {};
  try {
    statusBody = JSON.parse(curl.stdout);
  } catch {}
  check(
    "6. curl $OPEN_FACTORY_URL/api/status from the container answers",
    curl.code === 0 && statusBody.db === undefined && typeof statusBody.version === "string",
    `GET ${config.agentUrl}/api/status → exit ${curl.code}: ${brief(curl.stdout)}`,
  );

  // 7. No sudo in agent containers (Q11b).
  const sudo = await exec(["sudo", "-n", "true"]);
  check(
    "7. sudo -n true fails in the container",
    sudo.code !== 0,
    `exit code ${sudo.code}: ${brief(sudo.stdout)}`,
  );

  // 8. AC4: SIGKILL of Claude in the container.
  const crashFrom = await lastSeq();
  const startedBefore = (await inspect()).State.StartedAt;
  const kill = await exec(["pkill", "-KILL", "-x", "claude"]);
  must("8. docker exec … pkill -KILL -x claude", kill.code === 0, `exit code ${kill.code}`);
  const recovered = await step("8. one notice-led resume completes (≤ 4 min)", () =>
    until(
      "the recovery turn",
      async () => {
        const es = evs(await since(crashFrom));
        const ps = es.findIndex((e) => e.type === "process_started");
        if (ps === -1) return undefined;
        return es.slice(ps).some((e) => e.type === "turn_end" && !e.originKind) ? es : undefined;
      },
      240_000,
    ),
  );
  // Give a second (wrong) resume time to show up before counting.
  await sleep(10_000);
  const crashEvents = evs(await since(crashFrom));
  say(`    events since the kill:\n    ${lifecycle(crashEvents)}`);
  const exited = recovered.find((e) => e.type === "exited");
  check(
    "8. exited unexpectedly (a crash)",
    exited?.type === "exited" && exited.expected === false,
    brief(JSON.stringify(exited)),
  );
  const cleanupEv = recovered.find((e) => e.type === "cleanup");
  const startedAfter = (await inspect()).State.StartedAt;
  check(
    "8. container stopped after the crash (cleanup event; started again for the resume)",
    cleanupEv?.type === "cleanup" &&
      cleanupEv.container === "stopped" &&
      startedAfter !== startedBefore,
    `${brief(JSON.stringify(cleanupEv))}; StartedAt ${startedBefore} → ${startedAfter}`,
  );
  const procsAfter = await procs();
  const oldSleep = procsAfter.find((p) => p.cmd === "sleep 600" && p.start === sleepProc?.start);
  check(
    "8. the background sleep 600 is gone",
    !oldSleep,
    `old sleep (start ${sleepProc?.start}): ${oldSleep ? "still running" : "gone"}; sleeps now: ${procsAfter.filter((p) => p.cmd.startsWith("sleep 600")).length}`,
  );
  const lost = recovered.find((e) => e.type === "background_work_lost");
  check(
    "8. background_work_lost{crash} names the sleep",
    lost?.type === "background_work_lost" &&
      lost.reason === "crash" &&
      lost.tasks.some((t) => /sleep/i.test(t.description ?? "")),
    brief(JSON.stringify(lost)),
  );
  const starts = crashEvents.filter((e) => e.type === "process_started");
  check(
    "8. exactly one automatic resume (process_started{crash_recovery, resumed})",
    starts.length === 1 &&
      starts[0]?.type === "process_started" &&
      starts[0].reason === "crash_recovery" &&
      starts[0].resumed === true,
    starts.map((s) => JSON.stringify(s)).join(", "),
  );
  const firstIn = recovered.find((e) => e.type === "message_in");
  const first = firstIn?.type === "message_in" ? firstIn.messages[0] : undefined;
  check(
    "8. the resume's first batch begins with the @factory crash notice",
    first?.kind === "system" &&
      first.from === "@factory" &&
      first.body.startsWith("Your previous process stopped unexpectedly"),
    brief(JSON.stringify(first)),
  );
  const claudes = procsAfter.filter((p) => p.comm === "claude");
  const live8 = (await app.runtimes.bySlug(SLUG))?.live();
  check(
    "8. the agent recovered: not errored, one claude in the container",
    live8?.status !== "errored" && claudes.length === 1,
    `status: ${live8?.status}; claudes: ${claudes.length}; reply: ${brief(textOf(recovered))}`,
  );
} catch (err) {
  if (!(err instanceof StopRun))
    fail(
      "unexpected error",
      redact(err instanceof Error ? (err.stack ?? err.message) : String(err)),
    );
} finally {
  if (failures && serverWarnings.length)
    say(`\nserver warnings (redacted):\n  ${serverWarnings.slice(-15).join("\n  ")}`);
  await cleanup();
}

console.log(failures ? `\nSmoke FAILED (${failures} failed).` : "\nSmoke passed.");
process.exit(failures ? 1 : 0);
