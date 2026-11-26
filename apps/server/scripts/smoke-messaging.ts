// Live messaging check for S6 (spec §17.5). Not part of `pnpm test`.
// Needs Postgres (pnpm compose up -d), a real `claude` on the host PATH (credential verification runs there), the OAuth
// token in ~/.open-factory-spike/oauth-token and, for Docker agents (the default), Docker with the local image
// open-factory-base:dev and the CLI bundle (pnpm build). `--local` runs the agents on the host instead
// (FACTORY_ALLOW_LOCAL_RUNTIME=true for this run only). The token is read from that file at run time into a factory
// credential and is never printed: everything this script prints goes through `redact`.
// Uses a throwaway database and a temp FACTORY_HOME; the human server and the agent listener listen on loopback
// (Docker Desktop reaches loopback at host.docker.internal; on plain Linux the listener adds the bridge gateway).
// Model: haiku. A member update debounce of 20 s (factory settings): long enough for a short report turn to land in one
// batch, short enough to reach a manager in the middle of a 60 s Bash call.
// Org: `lead` (top) with reports `ada` and `bob`; humans `or` and `sam`.
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
import { bySlug } from "./by-slug.ts";

const LOCAL = process.argv.includes("--local");
const IMAGE = "open-factory-base:dev";
const SLUGS = ["lead", "ada", "bob"] as const;
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

/** A step that later steps don't depend on: on a throw it prints FAIL and the run goes on. */
async function soft<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const r = await fn();
    ok(name);
    return r;
  } catch (err) {
    fail(name, err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    return undefined;
  }
}

// ---------- temp dirs ----------
// realpath: macOS tmpdir is a /var symlink; the factory works with canonical paths.
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "of-smoke-msg-")));
const factoryHome = path.join(root, "home");
const hostClaudeDir = path.join(root, "host-claude");
const hostSkillsDir = path.join(hostClaudeDir, "skills");
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
let listenerReady: { hosts?: unknown; port?: unknown } | undefined;
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
        };
        if (o.msg === "agent listener ready") listenerReady = { hosts: o.hosts, port: o.port };
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
const resultOf = (es: SessionEvent[], toolUseId: string) => {
  const r = es.find((e) => e.event.type === "tool_result" && e.event.toolUseId === toolUseId);
  return r?.event.type === "tool_result" ? r.event : undefined;
};
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

let orUser = { userId: "", handle: "or" };

/** Sends a human message (as @or) and returns its row id and the recipient's seq before it. */
async function send(slug: Slug, body: string) {
  const from = await lastSeq(slug);
  const [sent] = (await app.router.send(orUser, [slug], body, false)).results;
  if (!sent || sent.status === "refused" || sent.status === "start_failed")
    throw new Error(
      `send to ${slug} failed: ${sent?.status === "refused" ? sent.reason : sent?.note}`,
    );
  return { id: sent.id, from };
}
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
/**
 * Model behaviour can be flaky: a prompt is retried at most twice, each time with a tightened prompt, and the retry
 * is printed. `accept` returns undefined to retry.
 */
async function ask<T>(
  slug: Slug,
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

const LONG_BASH = (secs: number) =>
  `Run this exact command with the Bash tool, in the foreground, in one call: perl -e 'sleep ${secs}' && echo slept ${secs}\nThen say done.`;
/** Waits for a Bash call that sleeps `secs` and checks it is still running (no result yet) 3 s later. */
async function longBash(slug: Slug, from: number, secs: number) {
  const call = await until(
    `${slug}'s Bash sleep ${secs}`,
    async () => {
      const es = await since(slug, from);
      const c = calls(es, "Bash").find((x) =>
        new RegExp(`sleep ${secs}`).test(JSON.stringify(x.event.input)),
      );
      if (c) return c;
      if (es.some((e) => e.event.type === "turn_end" && !e.event.originKind))
        throw new Error(
          `${slug}'s turn ended without the Bash call: ${toolTrace(es)}; ${brief(textOf(es))}`,
        );
      return undefined;
    },
    240_000,
  );
  await sleep(3000);
  const r = resultOf(await since(slug, from), call.event.toolUseId);
  if (r) throw new Error(`the Bash call already returned: ${brief(r.content)}`);
  return call;
}
/** No open turn and nothing queued for 10 s in a row (the agents may still be talking to each other). */
async function quiet(slugs: Slug[]) {
  let since0 = 0;
  await until(
    `${slugs.join(", ")} to go quiet`,
    async () => {
      const busy = [];
      for (const s of slugs) {
        const rt = await bySlug(app, s);
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

/** Step 7 (§5.1): no request to the agent listener carried an Origin header; how the factory MCP connected. */
async function finalChecks() {
  const posts = mcpRequests.filter((r) => r.method === "POST");
  const listenerCodes: Record<string, number> = {};
  for (const r of mcpRequests) {
    const k = `${r.method} ${r.status ?? "?"}`;
    listenerCodes[k] = (listenerCodes[k] ?? 0) + 1;
  }
  const sources = [...new Set(mcpRequests.map((r) => r.remoteAddress))];
  check(
    "7. no Origin header reached the agent listener (an Origin gets 403: none in the request log)",
    posts.length > 0 && !mcpRequests.some((r) => r.status === 403) && !statusCodes.has(403),
    `/mcp requests by method and status: ${JSON.stringify(listenerCodes)}; all response codes in the run: ${JSON.stringify(Object.fromEntries(statusCodes))}; remote addresses seen by the listener: ${sources.join(", ")}; POSTs that never got a response: ${mcpRequests.filter((r) => r.method === "POST" && r.status === undefined).length}`,
  );
  for (const slug of SLUGS) {
    const es = await since(slug);
    const unavailable = es.filter((e) => e.event.type === "mcp_unavailable");
    const starts = es.filter((e) => e.event.type === "session_started");
    // How long after each start the factory MCP answered, and the first call that found the tool missing.
    // The /mcp requests in the minute after each process start (the log can't tell agents apart: any agent's).
    const procs = es.filter((e) => e.event.type === "process_started");
    const timing = procs.map((p) => {
      const t0 = Date.parse(p.at);
      const init = starts.find((e) => e.seq > p.seq);
      const status =
        init?.event.type === "session_started"
          ? init.event.mcpServers?.find((m) => m.name === "factory")?.status
          : undefined;
      const window = mcpRequests.filter(
        (r) => r.method === "POST" && r.time >= t0 && r.time < t0 + 60_000,
      );
      const list = window
        .slice(0, 6)
        .map((r) => `+${((r.time - t0) / 1000).toFixed(1)} s ${r.status ?? "no response"}`)
        .join(", ");
      return `process start seq ${p.seq} at ${p.at}: system/init factory status ${status}; POST /mcp after it: ${list || "none"}`;
    });
    const missing = calls(es, "mcp__factory__send_message")
      .concat(calls(es, "mcp__factory__list_peers"))
      .filter((c) => /No such tool available/.test(resultOf(es, c.event.toolUseId)?.content ?? ""));
    const searching = es.filter(
      (e) =>
        e.event.type === "tool_result" &&
        /MCP servers are still connecting: factory/.test(e.event.content),
    );
    check(
      `7. ${slug}: the factory tools were there when the agent first needed them (no "No such tool available", no "still connecting"), no mcp_unavailable`,
      starts.length > 0 &&
        missing.length === 0 &&
        searching.length === 0 &&
        unavailable.length === 0,
      `${timing.join("\n    ")}\n    calls that found the tool missing: ${missing.map((c) => `seq ${c.seq} at ${c.at}`).join(", ") || "none"}; ToolSearch "still connecting": ${searching.length}; mcp_unavailable: ${unavailable.length}`,
    );
  }
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
  say(
    `mode: ${LOCAL ? "local agents (FACTORY_ALLOW_LOCAL_RUNTIME=true)" : `Docker agents on ${IMAGE}`}; model haiku; debounce 20 s`,
  );
  await step("0. setup: prerequisites", async () => {
    mkdirSync(hostSkillsDir, { recursive: true });
    if (LOCAL) return;
    if (!existsSync(config.cliBundle))
      throw new Error(`no CLI bundle at ${config.cliBundle}: run pnpm build first`);
    await dk.getImage(IMAGE).inspect();
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
  say(
    `  human server http://${config.host}:${config.port}; agent listener port ${app.agentListener.port}, bound to ${JSON.stringify(listenerReady?.hosts)}`,
  );
  say(
    `  MCP URL: ${LOCAL ? `http://127.0.0.1:${config.agentPort}/mcp` : `${config.agentUrl}/mcp`}`,
  );

  const users = await step("1. users @or and @sam signed up through the app", async () => {
    const or = await signUp("or", "Or");
    return { or, sam: await signUp("sam", "Sam", or) };
  });
  orUser = { userId: users.or.userId, handle: "or" };
  await step("1. factory settings: member update debounce 20 s", () =>
    patchFactorySettings(users.or.cookie, { memberUpdateDebounceSeconds: 20 }),
  );
  await step("1. credential created (live verification turn passed)", () =>
    app.credentials.create({ name: "smoke", kind: "oauth_token", value: token, expiresAt: null }),
  );
  await step(`1. template msg (${LOCAL ? "local" : "docker"}, haiku) is valid`, async () => {
    writeTemplate("msg", {
      "template.yaml": [
        "name: msg",
        "display_name: Msg",
        "description: Smoke messaging template",
        `runtime: ${LOCAL ? "local" : "docker"}`,
        "model: haiku",
        "",
      ].join("\n"),
      "AGENTS.md": [
        "# Msg",
        "",
        "You are a smoke-test agent. Follow instructions literally and keep replies short.",
        "When another agent sends you a message, reply to that agent with the mcp__factory__send_message tool.",
        "",
      ].join("\n"),
    });
    const r = (await app.templates.scan()).find((x) => x.name === "msg");
    const errs = r?.issues.filter((i) => i.severity === "error") ?? [];
    if (!r || errs.length) throw new Error(JSON.stringify(errs));
  });
  for (const [slug, reportsTo] of [
    ["lead", "or"],
    ["ada", "lead"],
    ["bob", "lead"],
  ] as const) {
    await step(`1. agent ${slug} created (reports to ${reportsTo})`, () =>
      app.agents.create(
        {
          template: "msg",
          slug,
          displayName: slug[0]?.toUpperCase() + slug.slice(1),
          description: `Smoke messaging agent ${slug}`,
          reportsTo,
          credential: "smoke",
        },
        { kind: "human", ref: "k7x2m9qd", handle: "or" },
      ),
    );
    ids.set(
      slug,
      String((await conn.sql`select id from agents where slug = ${slug}`)[0]?.id ?? ""),
    );
  }

  // 2. AC1: ada → hibernated bob with mcp__factory__send_message; bob wakes and replies.
  const bobFrom = await lastSeq("bob");
  const bobStatus = (await bySlug(app, "bob"))?.live().status;
  const t2 = await step("2. ada sends to bob with mcp__factory__send_message", () =>
    ask(
      "ada",
      [
        "Use mcp__factory__send_message to ask bob for a random word.",
        'Call the tool mcp__factory__send_message with to: ["bob"] and body: "Please reply with one random word." Then stop.',
        'You must call mcp__factory__send_message now, exactly once, with to: ["bob"] and body: "Please reply with one random word.". Do not use any other tool.',
      ],
      (es) =>
        okCalls(es, "mcp__factory__send_message").find((c) =>
          /bob/.test(JSON.stringify(c.event.input)),
        ) ?? undefined,
    ),
  );
  const aCall = t2.got;
  const aResult = resultOf(t2.turn, aCall.event.toolUseId);
  check(
    "2. ada's send_message call succeeded",
    aResult !== undefined && !aResult.isError,
    `${aCall.event.name}(${brief(JSON.stringify(aCall.event.input))}) → ${brief(aResult?.content ?? "no result")}`,
  );
  // Not a required step: when bob gives up, the rest of the run still exercises ACs 2–5 (and step 7 says why).
  const bobDone = await soft(
    "2. bob wakes and replies to ada with mcp__factory__send_message",
    () =>
      until(
        "bob's reply",
        async () => {
          const es = await since("bob", bobFrom);
          const reply = okCalls(es, "mcp__factory__send_message").find((c) =>
            /ada/.test(JSON.stringify(c.event.input)),
          );
          if (!reply) {
            const ended = es.some((e) => e.event.type === "turn_end" && !e.event.originKind);
            if (ended)
              throw new Error(
                `bob's turn ended without a reply; bob: ${toolTrace(es)}; text: ${brief(textOf(es))}`,
              );
            return undefined;
          }
          const after = es.filter((e) => e.seq > reply.seq);
          return after.some((e) => e.event.type === "turn_end" && !e.event.originKind)
            ? es
            : undefined;
        },
        240_000,
      ),
  );
  const bobEs = bobDone ?? (await since("bob", bobFrom));
  const bobStart = bobEs.find((e) => e.event.type === "process_started");
  check(
    "2. AC1: bob was hibernated and woke with process_started.reason = agent_message",
    bobStatus === "hibernated" &&
      bobStart?.event.type === "process_started" &&
      bobStart.event.reason === "agent_message",
    `bob before: ${bobStatus}; ${brief(JSON.stringify(bobStart?.event))}`,
  );
  const bobFirst = envelopes(bobEs)[0];
  check(
    "2. AC1: bob's first batch carries ada's message (from = ada)",
    Boolean(bobFirst?.envs.some((m) => m.kind === "message" && m.from === "ada")),
    (bobFirst?.envs ?? []).map(envBrief).join(" ; "),
  );
  if (bobDone) say(`    bob: ${toolTrace(bobDone)}`);
  const adaGot = await soft("2. ada receives bob's reply (from = bob)", async () => {
    if (!bobDone) throw new Error("bob did not reply");
    return until(
      "bob's message in ada's session",
      async () => {
        const es = await since("ada", t2.turn.at(-1)?.seq ?? 0);
        const i = es.findIndex(
          (e) =>
            e.event.type === "message_in" &&
            e.event.messages.some((m) => m.from === "bob" && m.kind === "message"),
        );
        if (i === -1) return undefined;
        const rest = es.slice(i);
        return rest.some((e) => e.event.type === "turn_end" && !e.event.originKind)
          ? rest
          : undefined;
      },
      240_000,
    );
  });
  if (adaGot)
    say(
      `    ada got: ${envelopes(adaGot)
        .flatMap((x) => x.envs.map(envBrief))
        .join(" ; ")}`,
    );
  const adaAll = await since("ada");
  const builtin = adaAll.filter(
    (e) => e.event.type === "tool_call" && e.event.name === "SendMessage",
  );
  check(
    "2. AC1: ada's session has a mcp__factory__send_message tool_call and none named SendMessage",
    calls(adaAll, "mcp__factory__send_message").length > 0 && builtin.length === 0,
    `send_message calls: ${calls(adaAll, "mcp__factory__send_message").length}; SendMessage calls: ${builtin.length}`,
  );

  // ada and bob may still be thanking each other: let them go quiet so step 3's turn reads only its message.
  await step("2. ada and bob are quiet (no open turn, nothing queued for 10 s)", () =>
    quiet(["ada", "bob"]),
  );

  // 3. I9 AC14: lead mid-turn while ada narrates and answers → ada's updates reach lead's running turn as one batched
  // member_update group once the debounce has passed, before that turn ends.
  // Claude Code's Bash tool blocks a bare `sleep N` in the foreground, so the long command is a perl sleep.
  const lead3 = await send("lead", LONG_BASH(60));
  const sleeping = await step("3. lead's 60 s Bash is running", () =>
    longBash("lead", lead3.from, 60),
  );
  const ada3 = await send(
    "ada",
    "Narrate two steps of working out 6 times 7, one short sentence each (Step 1: ..., Step 2: ...), then answer with the number.",
  );
  const ada3Turn = await step("3. ada narrates and answers while lead sleeps", () =>
    turnOf("ada", ada3.id, ada3.from),
  );
  const leadSleepTurn = await step("3. lead's sleep turn ends", () =>
    turnOf("lead", lead3.id, lead3.from),
  );
  const ada3End = ada3Turn.at(-1);
  const leadSleepEnd = leadSleepTurn.at(-1);
  check(
    "3. ada's turn ended before lead's turn",
    Boolean(ada3End && leadSleepEnd && ada3End.at < leadSleepEnd.at),
    `ada turn_end ${ada3End?.at}; lead turn_end ${leadSleepEnd?.at}; ada text: ${brief(textOf(ada3Turn), 200)}`,
  );
  const midTurn = envelopes(leadSleepTurn).slice(1);
  const adaGroups = midTurn.flatMap((b) =>
    b.envs.filter((m) => m.kind === "member_update" && m.from === "ada"),
  );
  const group = adaGroups[0];
  check(
    "3. AC14: one message_in written into lead's running turn, with one member_update group from ada",
    midTurn.length === 1 && adaGroups.length === 1,
    `${midTurn.length} message_in in the turn (sleep call at seq ${sleeping.seq}): ${midTurn.flatMap((b) => b.envs.map(envBrief)).join(" ; ")}`,
  );
  const partsText = (group?.parts ?? []).map((p) => p.body).join("\n");
  check(
    "3. AC14: the group holds ada's narration and answer (text only: no tool call, result or thinking)",
    Boolean(group) &&
      (group?.parts?.length ?? 0) >= 1 &&
      /42/.test(partsText || group?.body || "") &&
      !/tool_use|tool_result|thinking/.test(partsText),
    `parts: ${(group?.parts ?? []).map((p) => brief(p.body, 100)).join(" | ") || brief(group?.body ?? "", 200)}`,
  );
  say(`    lead's turn after the updates: ${brief(textOf(leadSleepTurn), 200)}`);

  // 4. AC3: an urgent message from ada interrupts lead's long Bash.
  await step("3. lead is quiet before step 4", () => quiet(["lead", "ada"]));
  const lead4 = await send("lead", LONG_BASH(60));
  await step("4. lead's 60 s Bash is running", () => longBash("lead", lead4.from, 60));
  const t4 = await step("4. ada sends an urgent message to lead", () =>
    ask(
      "ada",
      [
        'Send an urgent message to lead: call mcp__factory__send_message with to: ["lead"], urgent: true and body: "Urgent: please stop and reply."',
        'Call mcp__factory__send_message exactly once with to: ["lead"], body: "Urgent: please stop and reply." and urgent: true. Then stop.',
        'You must call mcp__factory__send_message now with the arguments {"to": "lead", "body": "Urgent: please stop and reply.", "urgent": true}. No other tool.',
      ],
      (es) =>
        okCalls(es, "mcp__factory__send_message").find((c) => {
          const i = c.event.input as { to?: unknown; urgent?: unknown };
          return /lead/.test(String(i.to)) && i.urgent === true;
        }) ?? undefined,
    ),
  );
  const urgentAt = Date.parse(t4.got.at);
  const control = await step("4. a control{interrupt} lands on lead", () =>
    until(
      "lead's control{interrupt}",
      async () =>
        (await since("lead", lead4.from)).find(
          (e) => e.event.type === "control" && e.event.cmd === "interrupt",
        ),
      60_000,
    ),
  );
  const lag = (Date.parse(control.at) - urgentAt) / 1000;
  check(
    "4. AC3: lead was interrupted within 10 s of ada's urgent send_message call",
    lag <= 10,
    `${brief(JSON.stringify(control.event))} ${lag.toFixed(1)} s after ada's call (${t4.got.at} → ${control.at})`,
  );
  const leadUrgent = await step("4. lead reads ada's urgent message", () =>
    until(
      "ada's urgent message in lead's session",
      async () => {
        const es = await since("lead", control.seq);
        const i = es.findIndex(
          (e) =>
            e.event.type === "message_in" &&
            e.event.messages.some((m) => m.from === "ada" && m.urgent),
        );
        if (i === -1) return undefined;
        return es.slice(i).some((e) => e.event.type === "turn_end" && !e.event.originKind)
          ? es
          : undefined;
      },
      240_000,
    ),
  );
  say(
    `    lead after the interrupt: ${envelopes(leadUrgent)
      .flatMap((x) => x.envs.map(envBrief))
      .join(" ; ")}`,
  );

  // 5. AC4: list_peers from ada.
  const t5 = await step("5. ada calls list_peers", () =>
    ask(
      "ada",
      [
        "Call mcp__factory__list_peers and tell me who you can message.",
        "Call the tool mcp__factory__list_peers with no arguments, then list the slugs and relations it returned.",
        "You must call mcp__factory__list_peers now, with no arguments. No other tool.",
      ],
      (es) => okCalls(es, "mcp__factory__list_peers")[0],
    ),
  );
  const peersRaw = resultOf(t5.turn, t5.got.event.toolUseId)?.content ?? "";
  let peers: { peers?: { handle: string; kind: string; relation?: string }[] } = {};
  try {
    peers = JSON.parse(peersRaw);
  } catch {}
  const rel = (slug: string) =>
    peers.peers?.find((a) => a.kind === "agent" && a.handle === `@${slug}`)?.relation;
  const handles = (peers.peers ?? [])
    .filter((p) => p.kind === "human")
    .map((h) => h.handle.slice(1));
  check(
    "5. AC4: list_peers names lead as manager, bob as peer, humans or and sam",
    rel("lead") === "manager" &&
      rel("bob") === "peer" &&
      handles.includes("or") &&
      handles.includes("sam") &&
      !rel("ada"),
    `result: ${brief(peersRaw, 400)}`,
  );

  // 6. AC5: ada messages both people by handle; each has the inbox item.
  const t6 = await step("6. ada messages @or and @sam", () =>
    ask(
      "ada",
      [
        `Use mcp__factory__send_message to tell @or and @sam: "Hello people, ${WORD}".`,
        `Call mcp__factory__send_message with to: ["@or", "@sam"] and body: "Hello people, ${WORD}". Then stop.`,
        `You must call mcp__factory__send_message now with {"to": ["@or", "@sam"], "body": "Hello people, ${WORD}"}. No other tool.`,
      ],
      (es) =>
        okCalls(es, "mcp__factory__send_message").find((c) => {
          const i = c.event.input as { to?: unknown; body?: unknown };
          return (
            /or/.test(String(i.to)) && /sam/.test(String(i.to)) && String(i.body).includes(WORD)
          );
        }) ?? undefined,
    ),
  );
  for (const [handle, u] of Object.entries(users)) {
    const res = await app.inject({
      method: "GET",
      url: "/api/inbox",
      headers: { cookie: u.cookie },
    });
    const items =
      (
        res.json() as {
          items?: {
            from: { name: string };
            to: string;
            preview: string;
            link: { agentSlug: string; seq?: number };
          }[];
        }
      ).items ?? [];
    const item = items.find((i) => i.preview.includes(WORD));
    check(
      `6. AC5: GET /api/inbox for @${handle} has ada's message, linked to the send_message call`,
      res.statusCode === 200 &&
        item?.from.name === "ada" &&
        item.to === `@${handle}` &&
        item.link.agentSlug === "ada" &&
        item.link.seq === t6.got.seq,
      `${res.statusCode}: ${brief(JSON.stringify(item ?? items), 300)}; call seq ${t6.got.seq}`,
    );
  }
} catch (err) {
  if (!(err instanceof StopRun))
    fail(
      "unexpected error",
      redact(err instanceof Error ? (err.stack ?? err.message) : String(err)),
    );
} finally {
  // 7 runs whatever happened before: it is also the diagnosis of a failed run.
  if (appBuilt && ids.size) await finalChecks().catch((e) => fail("7. final checks", String(e)));
  if (serverWarnings.length)
    say(`\nserver warnings (redacted):\n  ${serverWarnings.slice(-15).join("\n  ")}`);
  await cleanup();
}

console.log(failures ? `\nSmoke FAILED (${failures} failed).` : "\nSmoke passed.");
process.exit(failures ? 1 : 0);
