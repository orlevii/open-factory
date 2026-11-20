// Live scheduling check for S9 (spec §17.5). Not part of `pnpm test`. Phases: early (the first slice below), a (human
// every-minute schedule, agent limits and cancel), b (restart with a one-shot due during the downtime: fires once, late),
// c (replacement through a real path: a cap of 1 running agent), d (CronCreate pins, Stop crons, the passive
// notice); `--phase=a,c` picks some, `--early` is the first slice only (schedule tool
// listing, a human-created one-shot waking a hibernated agent with the scheduled envelope, the agent's own
// schedule_message / list_schedules calls, and a spawned agent that lists none of the three tools); without it the whole
// script runs.
// Needs Postgres (pnpm compose up -d), a real `claude` on the host PATH (credential verification runs there), the OAuth
// token in ~/.open-factory-spike/oauth-token and, for Docker agents (the default), Docker with the local image
// open-factory-base:dev and the CLI bundle (pnpm build). `--local` runs the agents on the host instead
// (FACTORY_ALLOW_LOCAL_RUNTIME=true for this run only). The token is read from that file at run time into a factory
// credential and is never printed: everything this script prints goes through `redact`.
// It drives only real REST routes (signed in as @or) and the real MCP endpoint (through the agents): no service calls,
// no test hooks, no bypass of limits. A throwaway database and a temp FACTORY_HOME; the template sets
// `warm_window_minutes: 1` (normal configuration). Model: haiku. Org: `ceo` (can spawn) and `dev` (both top level).
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
const EARLY = process.argv.includes("--early");
/** `--phase=a,b` runs only those phases (each does its own setup, so each fits a tool call); none runs them all. */
const PHASE_ARG = process.argv.find((a) => a.startsWith("--phase="))?.slice(8);
const PHASES = new Set(
  PHASE_ARG ? PHASE_ARG.split(",") : EARLY ? ["early"] : ["early", "a", "b", "c", "d"],
);
const IMAGE = "open-factory-base:dev";
const SLUGS = ["ceo", "dev"] as const;
type Slug = (typeof SLUGS)[number];
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
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "of-smoke-sched-")));
const factoryHome = path.join(root, "home");
const hostSkillsDir = path.join(root, "host-skills");
const WORD = `KESTREL-${randomBytes(3).toString("hex").toUpperCase()}`;

// ---------- server log capture (pino JSON lines, never printed raw) ----------
interface McpRequest {
  method: string;
  url: string;
  remoteAddress: string;
  time: number;
  status?: number;
}
/** Requests to the agent listener's /mcp, with their response codes (matched by the listener's request id). */
const mcpRequests: McpRequest[] = [];
const openMcp = new Map<string, McpRequest>();
/** Response codes of every request in the run (human server and agent listener). */
const statusCodes = new Map<number, number>();
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
          reqId?: string;
          req?: { method?: string; url?: string; remoteAddress?: string };
          res?: { statusCode?: number };
          hosts?: unknown;
          port?: unknown;
          agent?: string;
          line?: string;
        };
        if (o.msg === "claude stdout" && typeof o.line === "string" && o.agent) {
          const l = JSON.parse(o.line) as { type?: string; subtype?: string; tools?: unknown };
          if (l.type === "system" && l.subtype === "init" && Array.isArray(l.tools))
            inits.push({ slug: o.agent, time: o.time ?? Date.now(), tools: l.tools.map(String) });
        }
        if (o.msg === "incoming request" && o.req?.url?.startsWith("/mcp")) {
          const r: McpRequest = {
            method: String(o.req.method),
            url: String(o.req.url),
            remoteAddress: String(o.req.remoteAddress),
            time: o.time ?? Date.now(),
          };
          mcpRequests.push(r);
          if (o.reqId) openMcp.set(o.reqId, r);
        }
        if (o.msg === "request completed" && typeof o.res?.statusCode === "number") {
          statusCodes.set(o.res.statusCode, (statusCodes.get(o.res.statusCode) ?? 0) + 1);
          const r = o.reqId ? openMcp.get(o.reqId) : undefined;
          if (r && o.reqId) {
            r.status = o.res.statusCode;
            openMcp.delete(o.reqId);
          }
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
const ids = new Map<Slug, string>();
let tdb: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
let closeDb: (() => Promise<void>) | undefined;
let cleaned: Promise<void> | undefined;
const dk = new Docker();

function cleanup(): Promise<void> {
  cleaned ??= (async () => {
    if (appBuilt) {
      let closeErr = "";
      await app.close().catch((e) => {
        closeErr = String(e);
      });
      if (closeErr) fail("cleanup: closing the app failed", closeErr);
    }
    // Throwaway agents: remove their containers (by label, so only this run's agents are touched).
    if (!LOCAL)
      for (const id of ids.values()) {
        try {
          const listed = await dk.listContainers({
            all: true,
            filters: { label: [`${LABEL_AGENT_ID}=${id}`] },
          });
          for (const c of listed) await dk.getContainer(c.Id).remove({ force: true });
        } catch (e) {
          console.error(redact(`cleanup: removing a container failed: ${e}`));
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
const idOf = (slug: Slug) => {
  const id = ids.get(slug);
  if (!id) throw new Error(`no agent ${slug}`);
  return id;
};
const since = (slug: Slug, seq = 0): Promise<SessionEvent[]> =>
  app.store.after(idOf(slug), seq, 10_000);
const lastSeq = async (slug: Slug) => (await since(slug)).at(-1)?.seq ?? 0;
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
const calls = (es: SessionEvent[], name: string) =>
  es.filter(
    (e): e is SessionEvent & { event: Extract<AnyEvent, { type: "tool_call" }> } =>
      e.event.type === "tool_call" && e.event.name === name,
  );
/** Tool calls that got a non-error result (a call made before the tool was available fails and doesn't count). */
const okCalls = (es: SessionEvent[], name: string) =>
  calls(es, name).filter((c) => {
    const r = es.find(
      (e) => e.event.type === "tool_result" && e.event.toolUseId === c.event.toolUseId,
    );
    return r?.event.type === "tool_result" && !r.event.isError;
  });
const envelopes = (es: SessionEvent[]) =>
  es.flatMap((e) =>
    e.event.type === "message_in" ? [{ seq: e.seq, at: e.at, envs: e.event.messages }] : [],
  );
const envBrief = (m: Envelope) =>
  `${m.kind} from=${m.from}${m.about ? ` about=${m.about}` : ""}${m.parts ? ` parts=${m.parts.length}` : ""}: ${brief(m.body, 120)}`;

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

let orCookie = "";
/** Every human action goes through the real REST routes, signed in as @or (no service calls, no bypass). */
const api = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: orCookie }, ...(payload ? { payload } : {}) });

/** The events of the turn that read message `id`: from its message_in to the first origin-less turn_end after it. */
async function turnOf(slug: Slug, id: string, from: number, ms = 240_000) {
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
/** No open turn and nothing queued for 10 s in a row (the agents may still be talking to each other). */
async function quiet(slugs: Slug[]) {
  let since0 = 0;
  await until(
    `${slugs.join(", ")} to go quiet`,
    async () => {
      const busy = [];
      for (const s of slugs) {
        const rt = await app.runtimes.bySlug(s);
        const l = rt?.live();
        if (
          l?.turnOpen ||
          l?.status === "working" ||
          (rt?.queueItems().filter((i) => i.kind !== "held").length ?? 0) > 0
        )
          busy.push(s);
      }
      if (busy.length) since0 = 0;
      else if (!since0) since0 = Date.now();
      return since0 && Date.now() - since0 >= 10_000;
    },
    300_000,
    1000,
  );
}

function writeTemplate(name: string, files: Record<string, string>) {
  const dir = path.join(factoryHome, "templates", name);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
}

/** S10 §9.3: sign-up is invite-only once a user exists, so a later user signs up with an invite the inviter creates. */
async function signUp(handle: string, name: string, inviter?: { cookie: string }) {
  let invite: string | undefined;
  if (inviter) {
    const created = await app.inject({
      method: "POST",
      url: "/api/invites",
      headers: { cookie: inviter.cookie, origin: app.config.publicOrigin },
    });
    if (created.statusCode !== 201)
      throw new Error(`invite for ${handle} failed ${created.statusCode}: ${brief(created.body)}`);
    invite =
      new URL((created.json() as { link: string }).link).searchParams.get("invite") ?? undefined;
  }
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: { origin: app.config.publicOrigin },
    payload: {
      invite,
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

/** S10: the cap and the debounce are factory settings, set through the API after sign-up (no longer env vars). */
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

/** The three schedule tools a persistent agent gets (spec §9). */
const SCHEDULE_TOOLS = ["schedule_message", "list_schedules", "cancel_schedule"].map(
  (n) => `mcp__factory__${n}`,
);

/** Step 7: no request to the agent listener carried an Origin header (an Origin gets 403). */
async function finalChecks() {
  const posts = mcpRequests.filter((r) => r.method === "POST");
  const codes: Record<string, number> = {};
  for (const r of mcpRequests) {
    const k = `${r.method} ${r.status ?? "?"}`;
    codes[k] = (codes[k] ?? 0) + 1;
  }
  check(
    "7. no Origin header reached the agent listener (an Origin gets 403: none in the request log)",
    posts.length > 0 && !mcpRequests.some((r) => r.status === 403) && !statusCodes.has(403),
    `/mcp requests by method and status: ${JSON.stringify(codes)}; all response codes in the run: ${JSON.stringify(Object.fromEntries(statusCodes))}`,
  );
  for (const slug of SLUGS) {
    const es = await since(slug);
    const unavailable = es.filter((e) => e.event.type === "mcp_unavailable");
    check(
      `7. ${slug}: no mcp_unavailable`,
      unavailable.length === 0,
      `mcp_unavailable: ${unavailable.length}`,
    );
  }
}

const hasFiring = (m: Envelope) => m.kind === "scheduled";

/** Config for the run's (fixed) ports; the cap and the debounce are factory settings (patched after sign-up). */
function makeConfig(ports: { port: number; agentPort: number }) {
  if (!tdb) throw new Error("no database");
  return loadConfig({
    ...process.env,
    DATABASE_URL: tdb.url,
    FACTORY_SECRET_KEY: "s".repeat(40),
    FACTORY_HOME: factoryHome,
    FACTORY_HOST_SKILLS_DIR: hostSkillsDir,
    FACTORY_DEFAULT_IMAGE: IMAGE,
    FACTORY_ALLOW_LOCAL_RUNTIME: LOCAL ? "true" : "false",
    FACTORY_TIMEZONE: "Europe/Berlin",
    HOST: "127.0.0.1",
    PORT: String(ports.port),
    FACTORY_AGENT_PORT: String(ports.agentPort),
    NODE_ENV: "development",
  });
}
let conn!: ReturnType<typeof createDb>;
async function startApp(config: ReturnType<typeof loadConfig>) {
  app = await buildApp(config, {
    db: conn.db,
    sql: conn.sql,
    logger: { level: "debug", stream: logStream },
  });
  appBuilt = true;
  await app.listen({ host: config.host, port: config.port });
}
/** The phases that need the cap of one run with it from the start. */
const MAX_RUNNING = PHASES.has("c") || PHASES.has("d") ? 1 : 8;

try {
  // 0. Setup (inside the try so a failure here still cleans up).
  const ports = { port: await freePort(), agentPort: await freePort() };
  tdb = await createTestDatabase();
  await migrate(tdb.url, MIGRATIONS_DIR);
  const config = makeConfig(ports);
  say(
    `mode: ${LOCAL ? "local agents (FACTORY_ALLOW_LOCAL_RUNTIME=true)" : `Docker agents on ${IMAGE}`}; model haiku; phases ${[...PHASES].join(",")}; max running agents ${MAX_RUNNING}`,
  );
  await step("0. setup: prerequisites", async () => {
    mkdirSync(hostSkillsDir, { recursive: true });
    if (LOCAL) return;
    if (!existsSync(config.cliBundle))
      throw new Error(`no CLI bundle at ${config.cliBundle}: run pnpm build first`);
    await dk.getImage(IMAGE).inspect();
  });
  conn = createDb(tdb.url);
  closeDb = conn.close;
  await startApp(config);
  say(
    `  human server http://${config.host}:${config.port}; agent listener port ${app.agentListener.port}`,
  );
  const users = await step("1. users @or and @sam signed up through the app", async () => {
    const or = await signUp("or", "Or");
    return { or, sam: await signUp("sam", "Sam", or) };
  });
  orCookie = users.or.cookie;
  await step(
    `1. factory settings: max running agents ${MAX_RUNNING}, member update debounce 180 s`,
    () =>
      patchFactorySettings(users.or.cookie, {
        maxRunningAgents: MAX_RUNNING,
        memberUpdateDebounceSeconds: 180,
      }),
  );
  await step("1. credential created (live verification turn passed)", () =>
    app.credentials.create({ name: "smoke", kind: "oauth_token", value: token }),
  );
  await step(
    `1. templates sched and kid (${LOCAL ? "local" : "docker"}, haiku, warm window 1 min) are valid`,
    async () => {
      writeTemplate("sched", {
        "template.yaml": [
          "name: sched",
          "display_name: Sched",
          "description: Smoke scheduling template",
          `runtime: ${LOCAL ? "local" : "docker"}`,
          "model: haiku",
          "warm_window_minutes: 1",
          "can_spawn: [kid]",
          "max_live_spawns: 2",
          "",
        ].join("\n"),
        "AGENTS.md": [
          "# Sched",
          "",
          "You are a smoke-test agent. Follow instructions literally and keep replies short.",
          "Act only on scheduled messages and on messages from @or.",
          "",
        ].join("\n"),
      });
      writeTemplate("kid", {
        "template.yaml": [
          "name: kid",
          "display_name: Kid",
          "description: Smoke scheduling child",
          `runtime: ${LOCAL ? "local" : "docker"}`,
          "model: haiku",
          "",
        ].join("\n"),
        "AGENTS.md": "# Kid\n\nYou are a smoke-test agent. Follow your first message literally.\n",
      });
      const found = await app.templates.scan();
      for (const n of ["sched", "kid"]) {
        const r = found.find((x) => x.name === n);
        const errs = r?.issues.filter((i) => i.severity === "error") ?? [];
        if (!r || errs.length) throw new Error(`${n}: ${JSON.stringify(errs)}`);
      }
    },
  );
  for (const slug of SLUGS) {
    await step(`1. agent ${slug} created (top level)`, () =>
      app.agents.create({
        template: "sched",
        slug,
        displayName: slug[0]?.toUpperCase() + slug.slice(1),
        description: `Smoke scheduling agent ${slug}`,
        reportsTo: null,
        credential: "smoke",
      }),
    );
    ids.set(
      slug,
      String((await conn.sql`select id from agents where slug = ${slug}`)[0]?.id ?? ""),
    );
  }

  if (PHASES.has("early")) {
    // 1. A human creates a one-shot at now + 90 s to hibernated ceo through POST /api/schedules.
    const ceoFrom = await lastSeq("ceo");
    const ceoBefore = (await app.runtimes.bySlug("ceo"))?.live().status;
    const at = new Date(Date.now() + 90_000).toISOString();
    const created = await step(
      "2. @or creates a one-shot at now + 90 s for ceo (POST /api/schedules)",
      async () => {
        const r = await api("POST", "/api/schedules", {
          target: "ceo",
          at,
          timezone: "UTC",
          body: `Do these two things with the factory tools, in order. 1) Call mcp__factory__list_schedules. 2) Call mcp__factory__schedule_message twice, to yourself: once with cron "0 9 * * 1-5" and body "weekly ${WORD}", once with at ${new Date(Date.now() + 40 * 60_000).toISOString().slice(0, 16)} (UTC; timezone "UTC") and body "once ${WORD}". Then say DONE.`,
        });
        if (r.statusCode !== 201) throw new Error(`${r.statusCode} ${brief(r.body)}`);
        return (r.json() as { schedule: { key: string; nextRunAt: string } }).schedule;
      },
    );
    check(
      "2. the schedule is S-1 with nextRunAt = the one-shot time",
      created.key === "S-1" && created.nextRunAt === at,
      JSON.stringify(created),
    );
    const firedId = await until(
      "the scheduled row's message_in on ceo",
      async () => {
        const m = envelopes(await since("ceo", ceoFrom))
          .flatMap((x) => x.envs)
          .find(hasFiring);
        return m?.id;
      },
      240_000,
      1000,
    );
    const turn = await step("2. ceo's turn for the scheduled message ends", () =>
      turnOf("ceo", firedId, ceoFrom),
    );
    const start = (await since("ceo", ceoFrom)).find((e) => e.event.type === "process_started");
    check(
      "2. ceo was hibernated and woke with process_started.reason = scheduled",
      ceoBefore === "hibernated" &&
        start?.event.type === "process_started" &&
        start.event.reason === "scheduled",
      `ceo before: ${ceoBefore}; ${brief(JSON.stringify(start?.event))}`,
    );
    const tools = inits.find((i) => i.slug === "ceo")?.tools ?? [];
    check(
      "2. V3: system/init lists the three schedule tools",
      SCHEDULE_TOOLS.every((t) => tools.includes(t)),
      `missing: ${SCHEDULE_TOOLS.filter((t) => !tools.includes(t)).join(", ") || "none"}`,
    );
    const env = envelopes(await since("ceo", ceoFrom))
      .flatMap((x) => x.envs)
      .find(hasFiring);
    check(
      "2. the first batch holds a scheduled envelope from @scheduler, schedule S-1, by @or",
      env?.from === "@scheduler" &&
        env.scheduleKey === "S-1" &&
        env.by === "@or" &&
        Boolean(env.due),
      env ? `${envBrief(env)} schedule=${env.scheduleKey} by=${env.by} due=${env.due}` : "none",
    );
    say(`    ceo: ${toolTrace(turn)}`);
    check(
      "2. V4: ceo acted on the body: list_schedules once, schedule_message twice (one cron, one at), all with results",
      okCalls(turn, "mcp__factory__list_schedules").length >= 1 &&
        okCalls(turn, "mcp__factory__schedule_message").length === 2 &&
        okCalls(turn, "mcp__factory__schedule_message").some(
          (c) => (c.event.input as { cron?: string }).cron === "0 9 * * 1-5",
        ) &&
        okCalls(turn, "mcp__factory__schedule_message").some((c) =>
          Boolean((c.event.input as { at?: string }).at),
        ),
      toolTrace(turn),
    );
    check(
      "2. V4: ceo did not try to recreate the fired one-shot (no third schedule_message)",
      calls(turn, "mcp__factory__schedule_message").length === 2,
      `schedule_message calls: ${calls(turn, "mcp__factory__schedule_message").length}`,
    );
    const listed = (await api("GET", "/api/schedules?target=ceo")).json() as {
      schedules: {
        key: string;
        createdBy: { kind: string; slug?: string };
        cron?: string;
        at?: string;
      }[];
    };
    const mine = listed.schedules.filter(
      (s) => s.createdBy.kind === "agent" && s.createdBy.slug === "ceo",
    );
    check(
      "2. GET /api/schedules?target=ceo shows the two schedules created by ceo",
      mine.length === 2 && mine.some((s) => s.cron) && mine.some((s) => s.at),
      brief(JSON.stringify(mine)),
    );

    // 5 (early). ceo spawns a kid; the kid lists none of the three tools.
    const ceoFrom2 = await lastSeq("ceo");
    const spawnArgs = `{"template": "kid", "suffix": "one", "description": "says hello", "prompt": "Reply with the word pineapple and nothing else."}`;
    const ask = await step(
      "2. @or asks ceo to spawn a kid (POST /api/agents/ceo/messages)",
      async () => {
        const r = await api("POST", "/api/agents/ceo/messages", {
          body: `You must call mcp__factory__spawn_agent now, exactly once, with ${spawnArgs}. No other tool.`,
          urgent: false,
        });
        if (r.statusCode !== 202) throw new Error(`${r.statusCode} ${brief(r.body)}`);
        return (r.json() as { item: { id: string } }).item.id;
      },
    );
    await step("2. ceo's turn for the spawn request ends", () => turnOf("ceo", ask, ceoFrom2));
    const kid = await step("2. the kid's process initialises", () =>
      until(
        "the kid's system/init",
        async () => inits.find((i) => i.slug !== "ceo" && i.slug !== "dev"),
        240_000,
        1000,
      ),
    );
    check(
      "2. the spawned kid lists none of the three schedule tools",
      SCHEDULE_TOOLS.every((t) => !kid.tools.includes(t)) &&
        kid.tools.some((t) => t.includes("mcp__factory__")),
      `kid ${kid.slug} tools with the factory prefix: ${kid.tools.filter((t) => t.includes("mcp__factory__")).join(", ")}`,
    );
    await step("2. ceo and the kid go quiet", async () => {
      await quiet(["ceo"]);
    });
  }

  const scheduledEnv = async (from: number, ms = 240_000) =>
    until(
      "a scheduled envelope on ceo",
      async () =>
        envelopes(await since("ceo", from))
          .flatMap((x) => x.envs)
          .find(hasFiring),
      ms,
      1000,
    );
  const tell = async (slug: Slug, body: string) => {
    const r = await api("POST", `/api/agents/${slug}/messages`, { body, urgent: false });
    if (r.statusCode !== 202) throw new Error(`${r.statusCode} ${brief(r.body)}`);
    return (r.json() as { item: { id: string } }).item.id;
  };
  const resultOf = (es: SessionEvent[], c: { event: { toolUseId: string } }) => {
    const r = es.find(
      (e) => e.event.type === "tool_result" && e.event.toolUseId === c.event.toolUseId,
    );
    return r?.event.type === "tool_result" ? r.event : undefined;
  };

  if (PHASES.has("a")) {
    // 3. A human's every-minute schedule (humans have no floor) wakes hibernated ceo within a minute or two.
    const from = await lastSeq("ceo");
    const s1 = await step("3. @or creates '* * * * *' for ceo (POST /api/schedules)", async () => {
      const r = await api("POST", "/api/schedules", {
        target: "ceo",
        cron: "* * * * *",
        timezone: "UTC",
        body: `Reply with the single word TICK-${WORD}. Use no tools.`,
      });
      if (r.statusCode !== 201) throw new Error(`${r.statusCode} ${brief(r.body)}`);
      return (r.json() as { schedule: { key: string } }).schedule;
    });
    const env1 = await step("3. ceo receives the scheduled envelope", () =>
      scheduledEnv(from, 180_000),
    );
    check(
      "3. the envelope is from @scheduler for the schedule, by @or",
      env1.from === "@scheduler" && env1.scheduleKey === s1.key && env1.by === "@or",
      envBrief(env1),
    );
    await step("3. ceo's turn for it ends", () => turnOf("ceo", env1.id, from));
    await step("3. the every-minute schedule is deleted (DELETE /api/schedules)", async () => {
      const r = await api("DELETE", `/api/schedules/${s1.key}`);
      if (r.statusCode !== 200) throw new Error(`${r.statusCode} ${brief(r.body)}`);
    });
    await step("3. ceo goes quiet", () => quiet(["ceo"]));

    // 4. Agent limits and cancel, through the real MCP.
    const from2 = await lastSeq("ceo");
    const later = new Date(Date.now() + 30 * 60_000).toISOString().slice(0, 16);
    const id2 = await step(
      "4. @or asks ceo for an at schedule, a */5 one, and to cancel the first",
      () =>
        tell(
          "ceo",
          `Do these in order. 1) Call mcp__factory__schedule_message with {"body": "later ${WORD}", "at": "${later}", "timezone": "UTC"}. 2) Call mcp__factory__schedule_message with {"body": "too often", "cron": "*/5 * * * *"}. 3) Call mcp__factory__cancel_schedule with the id returned by step 1. Then say DONE.`,
        ),
    );
    const t2 = await step("4. ceo's turn ends", () => turnOf("ceo", id2, from2));
    say(`    ceo: ${toolTrace(t2)}`);
    const sm = calls(t2, "mcp__factory__schedule_message");
    const floor = sm.find((c) => (c.event.input as { cron?: string }).cron === "*/5 * * * *");
    const floorRes = floor ? resultOf(t2, floor) : undefined;
    check(
      "4. the */5 call got the 15-minute sentence as a tool error",
      floorRes?.isError === true &&
        floorRes.content.includes("Schedules can't fire more often than every 15 minutes"),
      brief(floorRes?.content ?? "no result"),
    );
    check(
      "4. cancel_schedule succeeded",
      okCalls(t2, "mcp__factory__cancel_schedule").length === 1,
      toolTrace(t2),
    );
    const after = (await api("GET", "/api/schedules?target=ceo")).json() as {
      schedules: { createdBy: { kind: string } }[];
    };
    check(
      "4. GET /api/schedules shows no schedule created by ceo (the at schedule was cancelled)",
      after.schedules.every((x) => x.createdBy.kind !== "agent"),
      brief(JSON.stringify(after.schedules.map((x) => x.createdBy))),
    );
    await step("4. ceo goes quiet", () => quiet(["ceo"]));
  }

  if (PHASES.has("b")) {
    // 5. Restart: a one-shot due while the server is down fires once at boot with late="true".
    const from = await lastSeq("ceo");
    const dueAt = new Date(Date.now() + 25_000);
    const s1 = await step("5. @or creates a one-shot at now + 25 s for ceo", async () => {
      const r = await api("POST", "/api/schedules", {
        target: "ceo",
        at: dueAt.toISOString(),
        timezone: "UTC",
        body: `Reply with the single word LATE-${WORD}. Use no tools.`,
      });
      if (r.statusCode !== 201) throw new Error(`${r.statusCode} ${brief(r.body)}`);
      return (r.json() as { schedule: { key: string } }).schedule;
    });
    await step(
      "5. the server stops at once and stays down more than a minute past the due time",
      async () => {
        await app.close();
        appBuilt = false;
        await sleep(Math.max(0, dueAt.getTime() + 70_000 - Date.now()));
      },
    );
    await step("5. the server starts again on the same database", () =>
      startApp(makeConfig(ports)),
    );
    const env = await step("5. ceo receives the scheduled envelope", () =>
      scheduledEnv(from, 240_000),
    );
    check(
      "5. it fired once, late (late=true, schedule S-1)",
      env.late === true &&
        env.scheduleKey === s1.key &&
        (env.firings === undefined || env.firings === 1),
      `${envBrief(env)} late=${env.late} due=${env.due} firings=${env.firings}`,
    );
    await step("5. ceo's turn ends", () => turnOf("ceo", env.id, from));
    const rows = await conn.sql`select count(*)::int as n from messages where kind = 'scheduled'`;
    check("5. exactly one scheduled row exists", rows[0]?.n === 1, JSON.stringify(rows[0]));
    const got = (await api("GET", `/api/schedules/${s1.key}`)).json() as {
      schedule: { state: string };
    };
    check(
      "5. the one-shot is done",
      got.schedule.state === "done",
      JSON.stringify(got.schedule.state),
    );
  }

  if (PHASES.has("c")) {
    // 6. Replacement through a real path: ceo holds the only slot, so dev stays queued while its schedule fires twice.
    const from = await lastSeq("ceo");
    const busy = await step("6. @or keeps ceo busy (a 170 s loop in the foreground)", () =>
      tell(
        "ceo",
        "Run exactly this command in the foreground with the Bash tool, with timeout 200000: for i in $(seq 1 85); do sleep 2; done . Then say DONE. Use no other tool.",
      ),
    );
    await step("6. ceo's turn is open", () =>
      until(
        "ceo's open turn",
        async () => (await app.runtimes.bySlug("ceo"))?.live().turnOpen,
        120_000,
        1000,
      ),
    );
    const s1 = await step("6. @or creates '* * * * *' for dev", async () => {
      const r = await api("POST", "/api/schedules", {
        target: "dev",
        cron: "* * * * *",
        timezone: "UTC",
        body: `Reply with the single word REPLACED-${WORD}. Use no tools.`,
      });
      if (r.statusCode !== 201) throw new Error(`${r.statusCode} ${brief(r.body)}`);
      return (r.json() as { schedule: { key: string } }).schedule;
    });
    const dump = async () => {
      const r =
        await conn.sql`select state, firings, late, created_at from messages where kind = 'scheduled' order by created_at`;
      say(`    diagnostics: scheduled rows ${JSON.stringify(r)}`);
      say(`    ceo: ${toolTrace(await since("ceo", from))}`);
      say(
        `    ceo status ${(await app.runtimes.bySlug("ceo"))?.live().status}; dev status ${(await app.runtimes.bySlug("dev"))?.live().status}`,
      );
    };
    const row = await step("6. dev's pending row covers two firings", () =>
      until(
        "one pending scheduled row with firings = 2",
        async () => {
          const r =
            await conn.sql`select id, firings from messages where kind = 'scheduled' and state = 'pending'`;
          return r.length === 1 && r[0]?.firings === 2 ? r[0] : undefined;
        },
        200_000,
        2000,
      ).catch(async (e) => {
        await dump();
        throw e;
      }),
    );
    const detail = (await api("GET", "/api/agents/dev")).json() as {
      agent: { status: string };
      queue: { scheduleKey?: string; firings?: number }[];
    };
    check(
      "6. dev is queued (not started) and its queue item names the schedule with firings 2",
      detail.agent.status === "queued" &&
        detail.queue.some((q) => q.scheduleKey === s1.key && q.firings === 2),
      JSON.stringify({
        status: detail.agent.status,
        queue: detail.queue.map((q) => ({ k: q.scheduleKey, f: q.firings })),
      }),
    );
    check("6. still one pending row for the schedule", row !== undefined, JSON.stringify(row));
    await step("6. the schedule is deleted", async () => {
      const r = await api("DELETE", `/api/schedules/${s1.key}`);
      if (r.statusCode !== 200) throw new Error(`${r.statusCode} ${brief(r.body)}`);
    });
    await step("6. ceo's turn ends", () => turnOf("ceo", busy, from, 300_000));
  }

  if (PHASES.has("d")) {
    // 7. Crons: CronCreate pins ceo past its 1-minute warm window; Stop crons hibernates it; the next wake carries the notice.
    const from = await lastSeq("ceo");
    const ask = await step("7. @or asks ceo to create a */2 cron", () =>
      tell(
        "ceo",
        `Call CronCreate with {"cron": "*/2 * * * *", "prompt": "Say PING-${WORD}", "recurring": true}. Then say DONE.`,
      ),
    );
    const t = await step("7. ceo's turn ends", () => turnOf("ceo", ask, from));
    say(`    ceo: ${toolTrace(t)}`);
    const live = (await api("GET", "/api/agents/ceo")).json() as {
      agent: { crons: { recurring: boolean; humanSchedule: string }[] };
    };
    check(
      "7. GET /api/agents/ceo lists one recurring cron",
      live.agent.crons.length === 1 && live.agent.crons[0]?.recurring === true,
      JSON.stringify(live.agent.crons),
    );
    await step("7. ceo stays up past its 1-minute warm window", async () => {
      await sleep(90_000);
      const st = (await app.runtimes.bySlug("ceo"))?.live().status;
      if (st === "hibernated") throw new Error("ceo hibernated while a cron was live");
    });
    const before = await lastSeq("ceo");
    const stopped = await step(
      "7. @or stops the crons (POST /api/agents/ceo/stop-crons)",
      async () => {
        const r = await api("POST", "/api/agents/ceo/stop-crons");
        if (r.statusCode !== 200) throw new Error(`${r.statusCode} ${brief(r.body)}`);
        return (r.json() as { status: string }).status;
      },
    );
    say(`    stop-crons answered ${stopped}`);
    const hib = await step("7. ceo hibernates with reason crons_stopped by @or", () =>
      until(
        "the hibernated event",
        async () =>
          (await since("ceo", before)).find(
            (e) => e.event.type === "hibernated" && e.event.reason === "crons_stopped",
          ),
        240_000,
        1000,
      ),
    );
    check(
      "7. the hibernated event carries by @or",
      hib.event.type === "hibernated" && hib.event.by === "@or",
      JSON.stringify(hib.event),
    );
    const from3 = await lastSeq("ceo");
    const ask3 = await step("7. @or sends a message to hibernated ceo", () =>
      tell("ceo", "Reply with the word OK. Use no tools."),
    );
    await step("7. ceo's turn ends", () => turnOf("ceo", ask3, from3));
    const first = envelopes(await since("ceo", from3))[0];
    check(
      "7. the first batch starts with the crons_stopped notice from @factory, then @or's message",
      first?.envs[0]?.kind === "system" &&
        first.envs[0].body.includes("stopped your crons") &&
        first.envs[1]?.id === ask3,
      first?.envs.map(envBrief).join(" ; "),
    );
  }
} catch (err) {
  if (!(err instanceof StopRun))
    fail(
      "unexpected error",
      redact(err instanceof Error ? (err.stack ?? err.message) : String(err)),
    );
} finally {
  if (appBuilt && ids.size) await finalChecks().catch((e) => fail("7. final checks", String(e)));
  if (serverWarnings.length)
    say(`\nserver warnings (redacted):\n  ${serverWarnings.slice(-15).join("\n  ")}`);
  await cleanup();
}

console.log(failures ? `\nSmoke FAILED (${failures} failed).` : "\nSmoke passed.");
process.exit(failures ? 1 : 0);
