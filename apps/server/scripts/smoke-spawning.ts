// Live spawning check for S7 (spec §17). Not part of `pnpm test`.
// Needs Postgres (pnpm compose up -d), a real `claude` on the host PATH (credential verification runs there), the OAuth
// token in ~/.open-factory-spike/oauth-token and, for Docker agents (the default), Docker with the local image
// open-factory-base:dev and the CLI bundle (pnpm build). `--local` runs the agents on the host instead
// (FACTORY_ALLOW_LOCAL_RUNTIME=true for this run only). The token is read from that file at run time into a factory
// credential and is never printed: everything this script prints goes through `redact`.
// Uses a throwaway database and a temp FACTORY_HOME; the human server and the agent listener listen on loopback.
// Model: haiku. A member update debounce of 10 s (factory settings) so the spawner hears from its child quickly.
// Org: `lead` (top, can_spawn: [helper, tech-lead, proxy-reviewer, developer], granted the temp
// git repo `app`).
// Part 1 (Task 10): one spawn (`helper-one`), the brief, the child's text as a member_update, one terminate.
// Part 2 (Task 21): spec §17.3 with real models. The lead spawns `proxy-reviewer-r1` and `tech-lead-t1` (each brief
// names the other); the tech lead writes plan.md into the repo and asks the reviewer, who replies; the lead hears both
// as member_update groups, terminates both and spawns `developer-d1` with the plan's path; the developer commits on a
// branch in its own worktree under `.worktrees/`. Every prompt names the exact tool and text, since models vary.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net, { type AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { createDb, MIGRATIONS_DIR, migrate } from "@open-factory/db";
import { createTestDatabase } from "@open-factory/db/testing";
import type { AnyEvent, Envelope, SessionEvent } from "@open-factory/shared";
import Docker from "dockerode";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { LABEL_AGENT_ID } from "../src/runtime/docker/containers.ts";

const LOCAL = process.argv.includes("--local");
const IMAGE = "open-factory-base:dev";
const TOKEN_FILE = path.join(homedir(), ".open-factory-spike", "oauth-token");
const SPAWN = "mcp__factory__spawn_agent";
const TERMINATE = "mcp__factory__terminate_agent";
const SEND = "mcp__factory__send_message";
const CHILD = "helper-one";
const TL = "tech-lead-t1";
const RV = "proxy-reviewer-r1";
const DEV = "developer-d1";

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
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]")
    // Agent tokens never reach a log line (the listener redacts them); belt and braces for anything echoed back.
    .replace(/Bearer [A-Za-z0-9_-]{20,}/g, "Bearer [redacted]");
const say = (s: string) => console.log(redact(s));
let failures = 0;
const ok = (name: string, detail?: string) => say(`PASS ${name}${detail ? `\n    ${detail}` : ""}`);
const fail = (name: string, detail?: string) => {
  failures++;
  say(`FAIL ${name}${detail ? `\n    ${detail}` : ""}`);
};
/** Prints the evidence on a pass too: the PR keeps this output. */
const check = (name: string, cond: boolean, detail?: string) =>
  cond ? ok(name, detail) : fail(name, detail);
class StopRun extends Error {}
/** A required step: on a throw it prints FAIL and stops the run (later steps depend on it). */
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

// ---------- temp dirs ----------
// realpath: macOS tmpdir is a /var symlink; the factory works with canonical paths.
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "of-smoke-spawn-")));
const factoryHome = path.join(root, "home");
const hostClaudeDir = path.join(root, "host-claude");
const hostSkillsDir = path.join(hostClaudeDir, "skills");
/** The granted project `app`: a real git repo with one commit on main. */
const repo = path.join(root, "app");
const WORD = `SPAWN-${randomBytes(3).toString("hex").toUpperCase()}`;
const PLAN = path.join(repo, "plan.md");

// ---------- server log capture (pino JSON lines, never printed raw) ----------
/** Each agent process's system/init tool list, read from the driver's debug log of claude's stdout. */
const inits: { slug: string; time: number; tools: string[] }[] = [];
const serverWarnings: string[] = [];
const logStream = new Writable({
  write(chunk, _enc, cb) {
    for (const raw of String(chunk).split("\n")) {
      if (!raw.trim()) continue;
      try {
        const o = JSON.parse(raw) as {
          level?: number;
          msg?: unknown;
          err?: unknown;
          time?: number;
          agent?: string;
          line?: string;
        };
        if (o.msg === "claude stdout" && typeof o.line === "string" && o.agent) {
          const l = JSON.parse(o.line) as { type?: string; subtype?: string; tools?: unknown };
          if (l.type === "system" && l.subtype === "init" && Array.isArray(l.tools))
            inits.push({ slug: o.agent, time: o.time ?? Date.now(), tools: l.tools.map(String) });
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
/** Every agent of this run, spawned ones included (their containers are removed by label at cleanup). */
const ids = new Map<string, string>();
let tdb: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
let closeDb: (() => Promise<void>) | undefined;
let sql!: ReturnType<typeof createDb>["sql"];
let cleaned: Promise<void> | undefined;
const dk = new Docker();
const containersOf = (id: string) =>
  dk.listContainers({ all: true, filters: { label: [`${LABEL_AGENT_ID}=${id}`] } });

function cleanup(): Promise<void> {
  cleaned ??= (async () => {
    // Every agent row of this run, spawned ones included, even when the run stopped before recording them.
    // Read before anything closes; the containers are removed through Docker directly, so after app.close() too.
    try {
      if (sql)
        for (const r of await sql<{ id: string; slug: string }[]>`select id, slug from agents`)
          ids.set(r.slug, r.id);
    } catch (e) {
      console.error(redact(`cleanup: listing this run's agents failed: ${e}`));
    }
    if (appBuilt) {
      let closeErr = "";
      await app.close().catch((e) => {
        closeErr = String(e);
      });
      if (closeErr) fail("cleanup: closing the app failed", closeErr);
    }
    if (!LOCAL)
      for (const id of ids.values()) {
        try {
          for (const c of await containersOf(id))
            await dk.getContainer(c.Id).remove({ force: true, v: true });
        } catch (e) {
          console.error(redact(`cleanup: removing a container failed: ${e}`));
        }
      }
    try {
      await closeDb?.();
    } catch (e) {
      console.error(redact(`cleanup: closing the db pool failed: ${e}`));
    }
    try {
      await tdb?.drop();
    } catch (e) {
      console.error(redact(`cleanup: dropping the throwaway database failed: ${e}`));
    }
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (e) {
      console.error(redact(`cleanup: removing ${root} failed: ${e}`));
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
const idOf = (slug: string) => {
  const id = ids.get(slug);
  if (!id) throw new Error(`no agent ${slug}`);
  return id;
};
const since = (slug: string, seq = 0): Promise<SessionEvent[]> =>
  app.store.after(idOf(slug), seq, 10_000);
const lastSeq = async (slug: string) => (await since(slug)).at(-1)?.seq ?? 0;
const textOf = (es: SessionEvent[]) =>
  es.flatMap((e) => (e.event.type === "assistant_text" ? [e.event.text] : [])).join("\n");
const toolTrace = (es: SessionEvent[]) =>
  es
    .flatMap(({ event: e }) =>
      e.type === "tool_call"
        ? [`${e.name}(${brief(JSON.stringify(e.input), 160)})`]
        : e.type === "tool_result"
          ? [`→${e.isError ? " ERROR" : ""} ${brief(e.content, 160)}`]
          : [],
    )
    .join(" | ");
type ToolCall = SessionEvent & { event: Extract<AnyEvent, { type: "tool_call" }> };
const calls = (es: SessionEvent[], name: string) =>
  es.filter((e): e is ToolCall => e.event.type === "tool_call" && e.event.name === name);
const resultEventOf = (es: SessionEvent[], toolUseId: string) =>
  es.find((e) => e.event.type === "tool_result" && e.event.toolUseId === toolUseId);
const resultOf = (es: SessionEvent[], toolUseId: string) => {
  const r = resultEventOf(es, toolUseId);
  return r?.event.type === "tool_result" ? r.event : undefined;
};
const okCalls = (es: SessionEvent[], name: string) =>
  calls(es, name).filter((c) => {
    const r = resultOf(es, c.event.toolUseId);
    return r !== undefined && !r.isError;
  });
const envelopes = (es: SessionEvent[]) =>
  es.flatMap((e) =>
    e.event.type === "message_in" ? [{ seq: e.seq, at: e.at, envs: e.event.messages }] : [],
  );
/** A grouped envelope carries its text in its parts; a single one in its body. */
const envText = (m: Envelope) => (m.parts?.length ? m.parts.map((p) => p.body).join("\n") : m.body);
const envBrief = (m: Envelope) =>
  `${m.kind} from=${m.from}${m.about ? ` about=${m.about}` : ""}${m.parts ? ` parts=${m.parts.length}` : ""}: ${brief(envText(m), 160)}`;

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

let orUser = { userId: "", handle: "or" };

/** Sends a human message (as @or) and returns its row id and the recipient's seq before it. */
async function send(slug: string, body: string) {
  const from = await lastSeq(slug);
  const [sent] = (await app.router.send(orUser, [slug], body, false)).results;
  if (!sent || sent.status === "refused" || sent.status === "start_failed")
    throw new Error(
      `send to ${slug} failed: ${sent?.status === "refused" ? sent.reason : sent?.note}`,
    );
  return { id: sent.id, from };
}
/** The events of the turn that read message `id`: from its message_in to the first origin-less turn_end after it. */
async function turnOf(slug: string, id: string, from: number, ms = 240_000) {
  return until(
    `${slug}'s turn for message ${id}`,
    async () => {
      const es = await since(slug, from);
      const err = es.find((e) => e.event.type === "error" && e.event.source !== "api");
      if (err) throw new Error(`${slug}: ${brief(JSON.stringify(err.event))}`);
      const i = es.findIndex(
        (e) =>
          e.event.type === "message_in" &&
          e.event.messages.some((m) => m.id === id || m.ids?.includes(id)),
      );
      if (i === -1) return undefined;
      const rest = es.slice(i);
      const end = rest.findIndex((e) => e.event.type === "turn_end" && !e.event.originKind);
      return end === -1 ? undefined : rest.slice(0, end + 1);
    },
    ms,
  );
}
/** A prompt is retried at most twice, each time tightened, and the retry is printed. `accept` returns undefined to retry. */
async function ask<T>(
  slug: string,
  prompts: string[],
  accept: (turn: SessionEvent[]) => T | undefined,
): Promise<{ turn: SessionEvent[]; got: T }> {
  let last: SessionEvent[] = [];
  for (const [n, prompt] of prompts.slice(0, 3).entries()) {
    if (n > 0) say(`    retry ${n}: ${slug} did not follow the prompt; tightened prompt sent`);
    const s = await send(slug, prompt);
    last = await turnOf(slug, s.id, s.from);
    const got = accept(last);
    if (got !== undefined) return { turn: last, got };
  }
  throw new Error(
    `${slug} did not follow the prompt after retries; tools: ${toolTrace(last) || "none"}; reply: ${brief(textOf(last))}`,
  );
}
/** No open turn and nothing queued for 10 s in a row. */
async function quiet(slugs: string[]) {
  let since0 = 0;
  await until(
    `${slugs.join(", ")} to go quiet`,
    async () => {
      const busy = [];
      for (const s of slugs) {
        const rt = await app.runtimes.bySlug(s);
        const l = rt?.live();
        if (l?.turnOpen || l?.status === "working" || rt?.hasDeliverable()) busy.push(s);
      }
      if (busy.length) since0 = 0;
      else if (!since0) since0 = Date.now();
      return since0 && Date.now() - since0 >= 10_000;
    },
    300_000,
    1000,
  );
}
const factoryTools = (tools: string[]) => tools.filter((t) => t.startsWith("mcp__factory__"));
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=smoke",
      "-c",
      "user.email=smoke@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
/** `to` may come with or without `@`. */
const sendsTo = (es: SessionEvent[], to: string) =>
  okCalls(es, SEND).filter(
    (c) => String((c.event.input as { to?: unknown }).to ?? "").replace(/^@/, "") === to,
  );
/** Every member_update the lead has received from `from`, across its whole session. */
const updatesFrom = async (from: string) =>
  envelopes(await since("lead")).flatMap((b) =>
    b.envs.filter((m) => m.kind === "member_update" && m.from === from),
  );
const agentRow = async (slug: string) =>
  (
    await sql<
      { id: string; kind: string; reports_to: string | null; terminated_at: string | null }[]
    >`select id, kind, reports_to, terminated_at::text as terminated_at from agents where slug = ${slug}`
  )[0];

function writeTemplate(name: string, files: Record<string, string>) {
  const dir = path.join(factoryHome, "templates", name);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
}

async function signUp(handle: string, name: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: { origin: app.config.publicOrigin },
    payload: {
      name,
      handle,
      email: `${handle}-${WORD.toLowerCase()}@example.invalid`,
      password: randomBytes(12).toString("hex"),
    },
  });
  if (res.statusCode !== 200)
    throw new Error(`sign-up ${handle} failed ${res.statusCode}: ${brief(res.body)}`);
  const setCookie = res.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie : [setCookie ?? ""])
    .map((c) => c.split(";")[0])
    .join("; ");
  const me = (await app.inject({ method: "GET", url: "/api/me", headers: { cookie } })).json() as {
    id: string;
  };
  return { cookie, userId: me.id };
}

/** S10: the debounce is a factory setting, set through the API after sign-up (no longer env vars). */
async function patchFactorySettings(cookie: string, body: Record<string, number>) {
  const res = await app.inject({
    method: "PATCH",
    url: "/api/settings/factory",
    headers: { cookie },
    payload: body,
  });
  if (res.statusCode !== 200)
    throw new Error(`PATCH /api/settings/factory failed ${res.statusCode}: ${brief(res.body)}`);
}

const childRow = () => agentRow(CHILD);

try {
  // 0. Setup (inside the try so a failure here still cleans up).
  const port = await freePort();
  const agentPort = await freePort();
  tdb = await createTestDatabase();
  await migrate(tdb.url, MIGRATIONS_DIR);
  const config = loadConfig({
    ...process.env,
    DATABASE_URL: tdb.url,
    FACTORY_SECRET_KEY: "s".repeat(40),
    FACTORY_HOME: factoryHome,
    FACTORY_HOST_CLAUDE_DIR: hostClaudeDir,
    FACTORY_DEFAULT_IMAGE: IMAGE,
    FACTORY_ALLOW_LOCAL_RUNTIME: LOCAL ? "true" : "false",
    HOST: "127.0.0.1",
    PORT: String(port),
    FACTORY_AGENT_PORT: String(agentPort),
    NODE_ENV: "development",
  });
  const runtime = LOCAL ? "local" : "docker";
  say(
    `mode: ${LOCAL ? "local agents (FACTORY_ALLOW_LOCAL_RUNTIME=true)" : `Docker agents on ${IMAGE}`}; model haiku; debounce 10 s`,
  );
  await step("0. setup: prerequisites", async () => {
    mkdirSync(hostSkillsDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(path.join(repo, "README.md"), "# app\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    if (LOCAL) return;
    if (!existsSync(config.cliBundle))
      throw new Error(`no CLI bundle at ${config.cliBundle}: run pnpm build first`);
    await dk.getImage(IMAGE).inspect();
  });
  const conn = createDb(tdb.url);
  closeDb = conn.close;
  sql = conn.sql;
  app = await buildApp(config, {
    db: conn.db,
    sql: conn.sql,
    logger: { level: "debug", stream: logStream },
  });
  appBuilt = true;
  await app.listen({ host: config.host, port: config.port });
  say(`  human server http://${config.host}:${config.port}; agent listener port ${agentPort}`);

  const or = await step("0. user @or signed up through the app", () => signUp("or", "Or"));
  orUser = { userId: or.userId, handle: "or" };
  await step("0. factory settings: member update debounce 10 s", () =>
    patchFactorySettings(or.cookie, { memberUpdateDebounceSeconds: 10 }),
  );
  await step("0. credential created (live verification turn passed)", () =>
    app.credentials.create({ name: "smoke", kind: "oauth_token", value: token, expiresAt: null }),
  );
  await step("0. temp git repo registered as project app", () =>
    app.projects.create({ name: "app", hostPath: repo }),
  );
  const TEMPLATES = ["lead", "helper", "tech-lead", "proxy-reviewer", "developer"];
  await step(`0. templates ${TEMPLATES.join(", ")} (${runtime}, haiku) are valid`, async () => {
    writeTemplate("lead", {
      "template.yaml": [
        "name: lead",
        "display_name: Lead",
        "description: Smoke spawning lead",
        `runtime: ${runtime}`,
        "model: haiku",
        "projects: [app]",
        "can_spawn: [helper, tech-lead, proxy-reviewer, developer]",
        "",
      ].join("\n"),
      "AGENTS.md": [
        "# Lead",
        "",
        "You are a smoke-test agent. Follow instructions literally and keep replies short.",
        "Act only on messages from @or. Updates from the agents you spawned are information: never call a tool because of one; answer an update with one short sentence and stop.",
        "",
      ].join("\n"),
    });
    writeTemplate("helper", {
      "template.yaml": [
        "name: helper",
        "display_name: Helper",
        "description: Smoke spawning helper",
        `runtime: ${runtime}`,
        "model: haiku",
        "",
      ].join("\n"),
      "AGENTS.md": [
        "# Helper",
        "",
        "You are a smoke-test agent. Follow the instructions in your first message literally and keep replies short.",
        "",
      ].join("\n"),
    });
    for (const [name, display] of [
      ["tech-lead", "Tech Lead"],
      ["proxy-reviewer", "Proxy Reviewer"],
      ["developer", "Developer"],
    ] as const)
      writeTemplate(name, {
        "template.yaml": [
          `name: ${name}`,
          `display_name: ${display}`,
          `description: Smoke spawning ${name}`,
          `runtime: ${runtime}`,
          "model: haiku",
          "projects: [app]",
          "",
        ].join("\n"),
        "AGENTS.md": [
          `# ${display}`,
          "",
          "You are a smoke-test agent. Follow the instructions in your brief literally, step by step, use exactly the paths, tools and texts it names, and keep replies short.",
          "",
        ].join("\n"),
      });
    const scanned = await app.templates.scan();
    for (const name of TEMPLATES) {
      const r = scanned.find((x) => x.name === name);
      const errs = r?.issues.filter((i) => i.severity === "error") ?? [];
      if (!r || errs.length) throw new Error(`${name}: ${JSON.stringify(errs)}`);
    }
  });

  // 1. Create lead through the REST API and ask it to spawn helper-one.
  await step("1. agent lead created through POST /api/agents (top level)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie: or.cookie, origin: app.config.publicOrigin },
      payload: {
        template: "lead",
        slug: "lead",
        displayName: "Lead",
        description: "Smoke spawning lead",
        reportsTo: null,
        credential: "smoke",
      },
    });
    if (res.statusCode !== 201) throw new Error(`${res.statusCode}: ${brief(res.body)}`);
    const id = (await sql<{ id: string }[]>`select id from agents where slug = 'lead'`)[0]?.id;
    if (!id) throw new Error(`no agent lead after ${brief(res.body)}`);
    ids.set("lead", id);
  });
  const PROMPT =
    "Call mcp__factory__spawn_agent with template helper, suffix one, description 'says hello', prompt 'Reply with the word pineapple and nothing else.' Then stop.";
  const t1 = await step("1. lead calls mcp__factory__spawn_agent", () =>
    ask(
      "lead",
      [
        PROMPT,
        `${PROMPT} Call the tool exactly once with {"template": "helper", "suffix": "one", "description": "says hello", "prompt": "Reply with the word pineapple and nothing else."}.`,
        `You must call mcp__factory__spawn_agent now, exactly once, with {"template": "helper", "suffix": "one", "description": "says hello", "prompt": "Reply with the word pineapple and nothing else."}. No other tool.`,
      ],
      (es) => calls(es, SPAWN)[0],
    ),
  );
  const spawnCall = t1.got;
  const spawnRes = resultEventOf(t1.turn, spawnCall.event.toolUseId);
  const spawnResult = resultOf(t1.turn, spawnCall.event.toolUseId);
  say(`    lead: ${toolTrace(t1.turn)}`);

  // 2. The lead's system/init lists spawn_agent.
  const leadInit = inits.find((i) => i.slug === "lead");
  check(
    `2. lead's system/init lists ${SPAWN}`,
    Boolean(leadInit?.tools.includes(SPAWN)),
    `factory tools: ${leadInit ? factoryTools(leadInit.tools).join(", ") : "no init seen"}`,
  );

  // 3. The tool_result arrives within 60 s of the tool_call.
  const gap = spawnRes ? (Date.parse(spawnRes.at) - Date.parse(spawnCall.at)) / 1000 : Infinity;
  check(
    "3. lead's spawn_agent tool_result arrived within 60 s of the tool_call, without an error",
    spawnResult !== undefined && !spawnResult.isError && gap <= 60,
    `gap ${gap.toFixed(1)} s (${spawnCall.at} → ${spawnRes?.at}); input ${brief(JSON.stringify(spawnCall.event.input), 200)} → ${brief(spawnResult?.content ?? "no result", 200)}`,
  );

  // 4. helper-one exists, is ephemeral, its container starts, its init has no spawn tools.
  const child = await step(`4. ${CHILD} exists and is ephemeral, reporting to lead`, async () => {
    const r = await childRow();
    if (!r) throw new Error(`no agent ${CHILD}`);
    ids.set(CHILD, r.id);
    if (r.kind !== "ephemeral" || r.reports_to !== idOf("lead"))
      throw new Error(`kind ${r.kind}, reports_to ${r.reports_to}`);
    return r;
  });
  if (!LOCAL)
    await step(`4. ${CHILD}'s container (label ${LABEL_AGENT_ID}) is running`, () =>
      until(
        `${CHILD}'s container`,
        async () => (await containersOf(child.id)).find((c) => c.State === "running"),
        120_000,
      ),
    );
  const childInit = await step(`4. ${CHILD}'s system/init arrived`, () =>
    until(`${CHILD}'s system/init`, async () => inits.find((i) => i.slug === CHILD), 120_000),
  );
  check(
    `4. ${CHILD}'s system/init lists ${SEND} but neither ${SPAWN} nor ${TERMINATE}`,
    childInit.tools.includes(SEND) &&
      !childInit.tools.includes(SPAWN) &&
      !childInit.tools.includes(TERMINATE),
    `factory tools: ${factoryTools(childInit.tools).join(", ") || "none"}`,
  );

  // 5. Its first message_in is lead's brief; it answers pineapple.
  const childTurn = await step(`5. ${CHILD}'s first turn ends`, () =>
    until(
      `${CHILD}'s first turn`,
      async () => {
        const es = await since(CHILD);
        const err = es.find((e) => e.event.type === "error" && e.event.source !== "api");
        if (err) throw new Error(`${CHILD}: ${brief(JSON.stringify(err.event))}`);
        return es.some((e) => e.event.type === "turn_end" && !e.event.originKind) ? es : undefined;
      },
      240_000,
    ),
  );
  const firstIn = envelopes(childTurn)[0];
  check(
    `5. ${CHILD}'s first message_in is lead's brief`,
    Boolean(firstIn?.envs.some((m) => m.from === "lead" && /pineapple/i.test(envText(m)))),
    (firstIn?.envs ?? []).map(envBrief).join(" ; ") || "no message_in",
  );
  check(
    `5. ${CHILD}'s assistant_text contains "pineapple"`,
    /pineapple/i.test(textOf(childTurn)),
    `text: ${brief(textOf(childTurn), 200)}; tools: ${toolTrace(childTurn) || "none"}`,
  );

  // 6. lead receives a member_update from helper-one with pineapple.
  const update = await step(`6. lead receives a member_update from ${CHILD} with "pineapple"`, () =>
    until(
      `the member_update in lead's session`,
      async () => {
        const es = await since("lead", t1.turn.at(-1)?.seq ?? 0);
        for (const b of envelopes(es))
          for (const m of b.envs)
            if (m.kind === "member_update" && m.from === CHILD && /pineapple/i.test(envText(m)))
              return m;
        return undefined;
      },
      180_000,
    ),
  );
  say(`    ${envBrief(update)}`);

  // 7. lead terminates helper-one.
  await step("7. lead is quiet before the terminate", () => quiet(["lead"]));
  const t7 = await step("7. lead calls mcp__factory__terminate_agent", () =>
    ask(
      "lead",
      [
        "Call mcp__factory__terminate_agent with slug helper-one.",
        'Call the tool mcp__factory__terminate_agent exactly once with {"slug": "helper-one"}. Then stop.',
        'You must call mcp__factory__terminate_agent now with {"slug": "helper-one"}. No other tool.',
      ],
      (es) => okCalls(es, TERMINATE)[0],
    ),
  );
  const termAt = Date.parse(t7.got.at);
  say(`    lead: ${toolTrace(t7.turn)}`);
  const row = await childRow();
  check(
    `7. ${CHILD} has terminated_at`,
    Boolean(row?.terminated_at),
    `terminated_at ${row?.terminated_at}`,
  );
  const ended = await step(`7. ${CHILD}'s session ends with terminated`, () =>
    until(
      `${CHILD}'s terminated event`,
      async () => (await since(CHILD)).find((e) => e.event.type === "terminated"),
      30_000,
    ),
  );
  check(
    `7. ${CHILD}'s terminated event is by lead`,
    ended.event.type === "terminated" && ended.event.by === "lead",
    `${brief(JSON.stringify(ended.event))} at ${ended.at}`,
  );
  if (!LOCAL) {
    const gone = await until(
      `${CHILD}'s container to be removed`,
      async () => ((await containersOf(child.id)).length === 0 ? Date.now() : undefined),
      30_000,
    ).catch(() => undefined);
    check(
      `7. docker ps -a --filter label=${LABEL_AGENT_ID}=<${CHILD}> is empty within 30 s`,
      gone !== undefined,
      gone
        ? `removed ${((gone - termAt) / 1000).toFixed(1)} s after the terminate call (polled)`
        : `still there: ${JSON.stringify((await containersOf(child.id)).map((c) => c.State))}`,
    );
  }

  // ---------- Part 2: spec §17.3 with real models ----------
  say("\npart 2: the §17.3 scenario");
  const WT = path.join(repo, ".worktrees", `${DEV}-impl`);
  const rvArgs = {
    template: "proxy-reviewer",
    suffix: "r1",
    description: "Reviews the plan",
    prompt: `You review the plan that @${TL} writes. Do not call any tool now: reply with the text 'Waiting for ${TL}.' and stop. When a message from ${TL} arrives, call mcp__factory__send_message with {"to": "${TL}", "body": "Approved ${WORD}."}, then reply with the text 'Review done: approved.' and stop.`,
  };
  const tlArgs = {
    template: "tech-lead",
    suffix: "t1",
    description: "Writes the plan",
    prompt: `You write the plan and get it reviewed by @${RV}. Do these steps now, in order. 1) With the Write tool, create the file ${PLAN} (in the main checkout, not in a worktree) with exactly this content: "# Plan ${WORD}\n\nAdd hello.txt containing the line hello.\n". 2) Call mcp__factory__send_message with {"to": "${RV}", "body": "Please review the plan at ${PLAN}."}. 3) Reply with the text 'Plan written; review requested.' and stop. When ${RV}'s reply arrives, call no tool: reply with the text 'Plan approved by ${RV}.' and stop.`,
  };
  const devArgs = {
    template: "developer",
    suffix: "d1",
    description: "Implements the plan",
    prompt: `Implement the plan at ${PLAN}. Do these steps now, in order. 1) Read ${PLAN} with the Read tool. 2) Run this one command with the Bash tool: git -C ${repo} worktree add ${WT} -b impl && echo hello > ${WT}/hello.txt && git -C ${WT} add hello.txt && git -C ${WT} commit -q -m 'Implement plan ${WORD}' 3) Reply with the text 'Committed on impl.' and stop.`,
  };
  const spawnArgs: Record<string, typeof rvArgs> = { [RV]: rvArgs, [TL]: tlArgs, [DEV]: devArgs };

  /** Asks the lead (once it is quiet) until `missing()` is empty: at most 3 prompts, each retry printed. */
  async function leadUntil(
    missing: () => Promise<string[]>,
    prompt: (left: string[], n: number) => string,
  ) {
    const turns: SessionEvent[] = [];
    for (let n = 0; n < 3; n++) {
      const left = await missing();
      if (!left.length) break;
      if (n > 0)
        say(
          `    retry ${n}: lead did not follow the prompt for ${left.join(", ")}; tightened prompt sent`,
        );
      await quiet(["lead"]);
      const s = await send("lead", prompt(left, n));
      turns.push(...(await turnOf("lead", s.id, s.from)));
    }
    const left = await missing();
    if (left.length)
      throw new Error(
        `still missing ${left.join(", ")} after retries; tools: ${toolTrace(turns) || "none"}; reply: ${brief(textOf(turns))}`,
      );
    return turns;
  }
  const spawnPrompt = (left: string[], n: number) =>
    n === 0
      ? `Call mcp__factory__spawn_agent ${left.length === 1 ? "once" : `${left.length} times, in this order`}, with exactly these arguments: ${left.map((s) => JSON.stringify(spawnArgs[s])).join(" ; then ")}. Then stop.`
      : `You must call mcp__factory__spawn_agent now, once for each of these argument objects, copied exactly: ${left.map((s) => JSON.stringify(spawnArgs[s])).join(" ; ")}. No other tool.`;
  const notSpawned = async (slugs: string[]) => {
    const left = [];
    for (const s of slugs) {
      const r = await agentRow(s);
      if (r) ids.set(s, r.id);
      else left.push(s);
    }
    return left;
  };
  const isEphemeralChild = async (slug: string) => {
    const r = await agentRow(slug);
    if (!r) throw new Error(`no agent ${slug}`);
    if (r.kind !== "ephemeral" || r.reports_to !== idOf("lead"))
      throw new Error(`${slug}: kind ${r.kind}, reports_to ${r.reports_to}`);
  };

  // 8. The lead spawns the pair (the reviewer first, so it exists when the tech lead messages it).
  const t8 = await step(`8. lead spawns ${RV} and ${TL} (each brief names the other)`, () =>
    leadUntil(() => notSpawned([RV, TL]), spawnPrompt),
  );
  say(`    lead: ${toolTrace(t8)}`);
  for (const s of [RV, TL])
    await step(`8. ${s} is ephemeral, reporting to lead`, () => isEphemeralChild(s));

  // 9. They message each other and the plan lands in the repo.
  const exchange = await step(
    `9. ${TL} and ${RV} message each other (send_message both ways) and ${PLAN.replace(root, "<tmp>")} exists`,
    () =>
      until(
        "the pair's exchange and plan.md",
        async () => {
          for (const s of [TL, RV]) {
            const err = (await since(s)).find(
              (e) => e.event.type === "error" && e.event.source !== "api",
            );
            if (err) throw new Error(`${s}: ${brief(JSON.stringify(err.event))}`);
          }
          const tl = await since(TL);
          const rv = await since(RV);
          const a = sendsTo(tl, RV)[0];
          const b = sendsTo(rv, TL)[0];
          return a && b && existsSync(PLAN) ? { tl, rv, a, b } : undefined;
        },
        420_000,
        2000,
      ).catch(async (e) => {
        say(`    ${TL}: ${toolTrace(await since(TL)) || "no tools"}`);
        say(`    ${RV}: ${toolTrace(await since(RV)) || "no tools"}`);
        say(`    plan.md exists: ${existsSync(PLAN)}`);
        throw e;
      }),
  );
  say(`    ${TL}: ${toolTrace(exchange.tl)}`);
  say(`    ${RV}: ${toolTrace(exchange.rv)}`);
  const planText = readFileSync(PLAN, "utf8");
  check(
    `9. plan.md holds the plan (# Plan ${WORD})`,
    planText.includes(`# Plan ${WORD}`),
    brief(planText),
  );
  const rvIn = envelopes(exchange.rv).flatMap((b) => b.envs);
  check(
    `9. ${RV} received ${TL}'s message`,
    rvIn.some((m) => m.kind === "message" && m.from === TL),
    rvIn.map(envBrief).join(" ; "),
  );

  // 10. The lead hears both children as member_update groups.
  for (const s of [TL, RV]) {
    const u = await step(`10. lead's session has a member_update group from ${s}`, () =>
      until(
        `a member_update from ${s} in lead's session`,
        async () => (await updatesFrom(s))[0],
        240_000,
      ),
    );
    say(`    ${envBrief(u)}`);
  }
  // Let the pair finish their turns (their last text still reaches the lead) before terminating them.
  await step(`10. ${TL}, ${RV} and lead are quiet`, () => quiet([TL, RV, "lead"]));

  // 11. The lead terminates both.
  const terminated = async (slugs: string[]) => {
    const left = [];
    for (const s of slugs) if (!(await agentRow(s))?.terminated_at) left.push(s);
    return left;
  };
  const t11 = await step(
    `11. lead terminates ${TL} and ${RV} with mcp__factory__terminate_agent`,
    () =>
      leadUntil(
        () => terminated([TL, RV]),
        (left, n) =>
          n === 0
            ? `Call mcp__factory__terminate_agent for each of: ${left.map((s) => JSON.stringify({ slug: s })).join(" and ")}. Then stop.`
            : `You must call mcp__factory__terminate_agent now, once with each of ${left.map((s) => JSON.stringify({ slug: s })).join(" and ")}. No other tool.`,
      ),
  );
  say(`    lead: ${toolTrace(t11)}`);
  for (const s of [TL, RV]) {
    const ev = await step(`11. ${s}'s session ends with terminated by lead`, () =>
      until(
        `${s}'s terminated event`,
        async () => (await since(s)).find((e) => e.event.type === "terminated"),
        30_000,
      ),
    );
    check(
      `11. ${s}'s terminated event is by lead`,
      ev.event.type === "terminated" && ev.event.by === "lead",
      `${brief(JSON.stringify(ev.event))} at ${ev.at}`,
    );
    if (!LOCAL) {
      const id = idOf(s);
      const gone = await until(
        `${s}'s container to be removed`,
        async () => (await containersOf(id)).length === 0,
        30_000,
      ).catch(() => false);
      check(
        `11. no container left for ${s} (label ${LABEL_AGENT_ID}) within 30 s`,
        gone,
        gone ? undefined : JSON.stringify((await containersOf(id)).map((c) => c.State)),
      );
    }
  }

  // 12. The lead spawns the developer with the plan's path.
  const t12 = await step(`12. lead spawns ${DEV} with the plan`, () =>
    leadUntil(() => notSpawned([DEV]), spawnPrompt),
  );
  say(`    lead: ${toolTrace(t12)}`);
  await step(`12. ${DEV} is ephemeral, reporting to lead`, () => isEphemeralChild(DEV));
  const devFirst = await step(`12. ${DEV}'s first message_in arrived`, () =>
    until(`${DEV}'s first message_in`, async () => envelopes(await since(DEV))[0], 180_000),
  );
  check(
    `12. ${DEV}'s first message_in is lead's brief naming plan.md`,
    devFirst.envs.some((m) => m.from === "lead" && envText(m).includes(PLAN)),
    devFirst.envs.map(envBrief).join(" ; "),
  );

  // 13. The developer commits on a branch in a worktree under .worktrees/.
  const wtRoot = `${path.join(repo, ".worktrees")}${path.sep}`;
  const committed = await step(
    `13. a commit exists on a branch checked out under <repo>/.worktrees/`,
    () =>
      until(
        "the developer's commit",
        async () => {
          const err = (await since(DEV)).find(
            (e) => e.event.type === "error" && e.event.source !== "api",
          );
          if (err) throw new Error(`${DEV}: ${brief(JSON.stringify(err.event))}`);
          const list = git(repo, "worktree", "list", "--porcelain");
          for (const block of list.split("\n\n")) {
            const wt = /^worktree (.+)$/m.exec(block)?.[1];
            const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
            if (!wt || !branch || !wt.startsWith(wtRoot)) continue;
            if (Number(git(repo, "rev-list", "--count", `main..${branch}`).trim()) > 0)
              return { wt, branch };
          }
          return undefined;
        },
        300_000,
        2000,
      ).catch(async (e) => {
        say(`    ${DEV}: ${toolTrace(await since(DEV)) || "no tools"}`);
        throw e;
      }),
  );
  say(
    `    branch ${committed.branch} at ${committed.wt.replace(root, "<tmp>")}: ${git(repo, "log", "-1", "--format=%h author=%an %s", committed.branch).trim()}`,
  );
  say(`    ${DEV}: ${toolTrace(await since(DEV))}`);

  // 14. The lead's session holds member_update groups from each child of the scenario.
  const u14 = await step(`14. lead's session has a member_update group from ${DEV}`, () =>
    until(`a member_update from ${DEV}`, async () => (await updatesFrom(DEV))[0], 240_000),
  );
  say(`    ${envBrief(u14)}`);
  const heard: string[] = [];
  for (const s of [TL, RV, DEV]) if ((await updatesFrom(s)).length) heard.push(s);
  check(
    "14. lead heard from each child (tech lead, reviewer, developer) as member_update groups",
    heard.length === 3,
    `from: ${heard.join(", ")}`,
  );

  // 15. A human terminates the developer through the UI route; its container goes too.
  await step(`15. ${DEV} is quiet`, () => quiet([DEV]));
  await step(`15. @or terminates ${DEV} through POST /api/agents/${DEV}/terminate`, async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/agents/${DEV}/terminate`,
      headers: { cookie: or.cookie, origin: app.config.publicOrigin },
    });
    if (res.statusCode >= 300) throw new Error(`${res.statusCode}: ${brief(res.body)}`);
  });
  if (!LOCAL) {
    const id = idOf(DEV);
    const gone = await until(
      `${DEV}'s container to be removed`,
      async () => (await containersOf(id)).length === 0,
      30_000,
    ).catch(() => false);
    check(`15. no container left for ${DEV} within 30 s`, gone);
  }
  check(
    "15. the developer's worktree and branch are kept after termination",
    existsSync(committed.wt) && git(repo, "branch", "--list", committed.branch).trim() !== "",
    `${committed.wt.replace(root, "<tmp>")}, ${committed.branch}`,
  );
} catch (err) {
  if (!(err instanceof StopRun))
    fail(
      "unexpected error",
      redact(err instanceof Error ? (err.stack ?? err.message) : String(err)),
    );
} finally {
  if (serverWarnings.length)
    say(`\nserver warnings (redacted):\n  ${serverWarnings.slice(-15).join("\n  ")}`);
  await cleanup();
}

console.log(failures ? `\nSmoke FAILED (${failures} failed).` : "\nSmoke passed.");
process.exit(failures ? 1 : 0);
