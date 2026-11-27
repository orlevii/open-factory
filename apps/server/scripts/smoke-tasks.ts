// Live tasks check for S8 (spec §17.5). Not part of `pnpm test`. `--early` runs the first slice only (tool listing,
// a human-created assignment, get_task, comment_task with a mention); without it the whole script runs.
// Needs Postgres (pnpm compose up -d), a real `claude` on the host PATH (credential verification runs there), the OAuth
// token in ~/.open-factory-spike/oauth-token and, for Docker agents (the default), Docker with the local image
// open-factory-base:dev and the CLI bundle (pnpm build). `--local` runs the agents on the host instead
// (FACTORY_ALLOW_LOCAL_RUNTIME=true for this run only). The token is read from that file at run time into a factory
// credential and is never printed: everything this script prints goes through `redact`.
// Uses a throwaway database and a temp FACTORY_HOME; the human server and the agent listener listen on loopback
// (Docker Desktop reaches loopback at host.docker.internal; on plain Linux the listener adds the bridge gateway).
// Model: haiku. A member update debounce of 180 s (factory settings) so an idle manager's batch can't split.
// Org: `dev` and `tester` (both top level); humans `or` and `sam`.
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
import { byHandle } from "./by-handle.ts";

const LOCAL = process.argv.includes("--local");
const IMAGE = "open-factory-base:dev";
const HANDLES = ["dev", "tester"] as const;
type Handle = (typeof HANDLES)[number];
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
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "of-smoke-tasks-")));
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
/** Each agent process's system/init tool list, read from the driver's debug log of claude's stdout. */
const inits: { handle: string; time: number; tools: string[] }[] = [];
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
            inits.push({ handle: o.agent, time: o.time ?? Date.now(), tools: l.tools.map(String) });
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
const ids = new Map<Handle, string>();
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
const idOf = (handle: Handle) => {
  const id = ids.get(handle);
  if (!id) throw new Error(`no agent ${handle}`);
  return id;
};
const since = (handle: Handle, seq = 0): Promise<SessionEvent[]> =>
  app.store.after(idOf(handle), seq, 10_000);
const lastSeq = async (handle: Handle) => (await since(handle)).at(-1)?.seq ?? 0;
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

let orUser = { userId: "", ref: "", handle: "or" };
let samUser = { userId: "", handle: "sam" };
let orCookie = "";
/** Every human action goes through the real REST routes, signed in as @or (no service calls, no bypass). */
const api = (method: "GET" | "POST" | "PATCH", url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: orCookie }, ...(payload ? { payload } : {}) });

/** The events of the turn that read message `id`: from its message_in to the first origin-less turn_end after it. */
async function turnOf(handle: Handle, id: string, from: number, ms = 240_000) {
  return until(
    `${handle}'s turn for message ${id}`,
    async () => {
      const es = await since(handle, from);
      const err = es.find((e) => e.event.type === "error" && e.event.source !== "api");
      if (err) throw new Error(`${handle}: ${brief(JSON.stringify(err.event))}`);
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
async function quiet(handles: Handle[]) {
  let since0 = 0;
  await until(
    `${handles.join(", ")} to go quiet`,
    async () => {
      const busy = [];
      for (const s of handles) {
        const rt = await byHandle(app, s);
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
    ref: string;
  };
  return { cookie, userId: me.id, ref: me.ref };
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

/** The five task tools every agent gets (spec §9). */
const TASK_TOOLS = ["create_task", "update_task", "list_tasks", "get_task", "comment_task"].map(
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
  for (const handle of HANDLES) {
    const es = await since(handle);
    const unavailable = es.filter((e) => e.event.type === "mcp_unavailable");
    check(
      `7. ${handle}: no mcp_unavailable`,
      unavailable.length === 0,
      `mcp_unavailable: ${unavailable.length}`,
    );
  }
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
    `mode: ${LOCAL ? "local agents (FACTORY_ALLOW_LOCAL_RUNTIME=true)" : `Docker agents on ${IMAGE}`}; model haiku`,
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
    `  human server http://${config.host}:${config.port}; agent listener port ${app.agentListener.port}`,
  );
  const users = await step("1. users @or and @sam signed up through the app", async () => {
    const or = await signUp("or", "Or");
    return { or, sam: await signUp("sam", "Sam", or) };
  });
  orUser = { userId: users.or.userId, ref: users.or.ref, handle: "or" };
  orCookie = users.or.cookie;
  await step("1. factory settings: member update debounce 180 s", () =>
    patchFactorySettings(users.or.cookie, { memberUpdateDebounceSeconds: 180 }),
  );
  samUser = { userId: users.sam.userId, handle: "sam" };
  await step("1. credential created (live verification turn passed)", () =>
    app.credentials.create({ name: "smoke", kind: "oauth_token", value: token, expiresAt: null }),
  );
  await step(`1. template tasks (${LOCAL ? "local" : "docker"}, haiku) is valid`, async () => {
    writeTemplate("tasks", {
      "template.yaml": [
        "name: tasks",
        "display_name: Tasks",
        "description: Smoke tasks template",
        `runtime: ${LOCAL ? "local" : "docker"}`,
        "model: haiku",
        "",
      ].join("\n"),
      "AGENTS.md": [
        "# Tasks",
        "",
        "You are a smoke-test agent. Follow instructions literally and keep replies short.",
        "",
      ].join("\n"),
    });
    const r = (await app.templates.scan()).find((x) => x.name === "tasks");
    const errs = r?.issues.filter((i) => i.severity === "error") ?? [];
    if (!r || errs.length) throw new Error(JSON.stringify(errs));
  });
  for (const handle of HANDLES) {
    await step(`1. agent ${handle} created (top level)`, () =>
      app.agents.create(
        {
          template: "tasks",
          handle,
          displayName: handle[0]?.toUpperCase() + handle.slice(1),
          description: `Smoke tasks agent ${handle}`,
          reportsTo: "or",
          credential: "smoke",
        },
        { kind: "human", ref: orUser.ref, handle: "or" },
      ),
    );
    ids.set(
      handle,
      String(
        (
          await conn.sql`select a.id from agents a join principals p on p.id = a.id where p.handle = ${handle}`
        )[0]?.id ?? "",
      ),
    );
  }

  // 2. AC 1: a human creates T-1 assigned to hibernated dev; dev wakes with the task_assigned envelope.
  const devFrom = await lastSeq("dev");
  const devBefore = (await byHandle(app, "dev"))?.live().status;
  const created = await step("2. @or creates T-1 assigned to dev (POST /api/tasks)", async () => {
    const r = await api("POST", "/api/tasks", {
      title: "Smoke one",
      body: `Read this task with get_task, then comment on it with comment_task mentioning @or and asking one short question. Include the word ${WORD}. Do not change the task's status yet: a human will tell you when to finish it.`,
      assignee: "dev",
    });
    if (r.statusCode !== 201) throw new Error(`${r.statusCode} ${brief(r.body)}`);
    return (r.json() as { task: { key: string; assignee: { handle: string } | null } }).task;
  });
  check(
    "2. the task has key T-1 and dev as assignee",
    created.key === "T-1" && created.assignee?.handle === "dev",
    JSON.stringify({ key: created.key, assignee: created.assignee }),
  );
  const assignedId = String(
    (
      await conn.sql`select id from messages where kind = 'task_assigned' and task_id is not null`
    )[0]?.id ?? "",
  );
  const turn = await step("2. dev's turn for the assignment ends", () =>
    turnOf("dev", assignedId, devFrom),
  );
  const start = (await since("dev", devFrom)).find((e) => e.event.type === "process_started");
  check(
    "2. AC 1: dev was hibernated and woke with process_started.reason = task_message",
    devBefore === "hibernated" &&
      start?.event.type === "process_started" &&
      start.event.reason === "task_message",
    `dev before: ${devBefore}; ${brief(JSON.stringify(start?.event))}`,
  );
  const tools = inits.find((i) => i.handle === "dev")?.tools ?? [];
  check(
    "2. system/init lists the five task tools",
    TASK_TOOLS.every((t) => tools.includes(t)),
    `missing: ${TASK_TOOLS.filter((t) => !tools.includes(t)).join(", ") || "none"}`,
  );
  const first = envelopes(await since("dev", devFrom))[0];
  const env = first?.envs.find((m) => m.kind === "task_assigned");
  check(
    "2. AC 1: dev's first batch holds a task_assigned envelope from @factory with task T-1",
    env?.taskKey === "T-1" && env.from === "@factory",
    first?.envs.map(envBrief).join(" ; "),
  );
  say(`    dev: ${toolTrace(turn)}`);
  check(
    "2. dev called get_task and comment_task, both with a result",
    okCalls(turn, "mcp__factory__get_task").length > 0 &&
      okCalls(turn, "mcp__factory__comment_task").length > 0,
    toolTrace(turn),
  );
  const inbox = (await api("GET", "/api/inbox")).json() as {
    items: {
      kind: string;
      read: boolean;
      from: { kind: string; name: string };
      link: { kind: string; key?: string; commentId?: string };
    }[];
  };
  const mention = inbox.items.find((i) => i.kind === "mention");
  check(
    "2. AC 2: GET /api/inbox for @or has one unread mention from dev linking T-1 and a comment id",
    inbox.items.filter((i) => i.kind === "mention").length === 1 &&
      mention?.read === false &&
      mention.from.name === "dev" &&
      mention.link.kind === "task" &&
      mention.link.key === "T-1" &&
      Boolean(mention.link.commentId),
    brief(JSON.stringify(mention)),
  );
  void samUser;

  // 3. AC 3 setup first: T-2 (depends on T-1, assigned to tester) exists BEFORE the human tells dev to finish T-1,
  // so dev can't mark T-1 done before the dependency is in place and race the unblocked check.
  const t2 = await step("3. @or creates T-2 depending on T-1, assigned to tester", async () => {
    const r = await api("POST", "/api/tasks", {
      title: "Smoke two",
      body: "Say OK in one word. Do not use any tools.",
      assignee: "tester",
      dependsOn: ["T-1"],
    });
    if (r.statusCode !== 201) throw new Error(`${r.statusCode} ${brief(r.body)}`);
    return (r.json() as { task: { key: string; blockedBy: string[] } }).task;
  });
  check(
    "3. T-2 is blocked by T-1",
    t2.key === "T-2" && t2.blockedBy.join() === "T-1",
    JSON.stringify(t2),
  );
  await step("3. dev and tester are quiet before the next step", () => quiet(["dev", "tester"]));

  // 4. AC 2: the human comments back mentioning @dev; dev receives a task_comment from @or and finishes the task.
  const devFrom2 = await lastSeq("dev");
  const testerFrom = await lastSeq("tester");
  const c = await step(
    "4. @or comments on T-1 mentioning @dev (POST /api/tasks/T-1/comments)",
    async () => {
      const r = await api("POST", "/api/tasks/T-1/comments", {
        body: "@dev Yes. Mark the task done when you have read this.",
      });
      if (r.statusCode !== 201) throw new Error(`${r.statusCode} ${brief(r.body)}`);
      return r.json() as {
        comment: { id: string };
        deliveredTo: { ref: string; handle: string }[];
      };
    },
  );
  check(
    "4. the comment reached dev",
    c.deliveredTo.some((d) => d.handle === "dev"),
    JSON.stringify(c.deliveredTo),
  );
  const commentRow = String(
    (
      await conn.sql`select id from messages where kind = 'task_comment' and from_id = ${orUser.userId}`
    )[0]?.id ?? "",
  );
  const turn2 = await step("4. dev's turn for the comment ends", () =>
    turnOf("dev", commentRow, devFrom2),
  );
  say(`    dev: ${toolTrace(turn2)}`);
  const env2 = envelopes(await since("dev", devFrom2))
    .flatMap((x) => x.envs)
    .find((m) => m.kind === "task_comment");
  check(
    "4. dev's batch holds a task_comment from @or about T-1 with the comment id",
    env2?.from === "@or" && env2.taskKey === "T-1" && env2.commentId === c.comment.id,
    env2 ? envBrief(env2) : "no task_comment envelope",
  );
  const done = okCalls(turn2, "mcp__factory__update_task").find(
    (x) => (x.event.input as { status?: string }).status === "done",
  );
  check("4. dev called update_task with status done", Boolean(done), toolTrace(turn2));

  // 5. AC 3: or (T-1's creator) hears of it as an inbox task_event; tester is told T-2 is unblocked.
  const inbox2 = (await api("GET", "/api/inbox")).json() as {
    items: { kind: string; fact?: string; link: { key?: string } }[];
  };
  const ev = inbox2.items.find((i) => i.kind === "task_event");
  check(
    "5. AC 3: @or's inbox has a task_event with fact done linking T-1",
    ev?.fact === "done" && ev.link.key === "T-1",
    brief(JSON.stringify(ev)),
  );
  const unblocked = await soft("5. AC 3: tester receives a task_update (unblocked) about T-2", () =>
    until(
      "tester's unblocked update",
      async () => {
        const es = await since("tester", testerFrom);
        return envelopes(es)
          .flatMap((x) => x.envs)
          .find((m) => m.kind === "task_update" && m.fact === "unblocked" && m.taskKey === "T-2");
      },
      240_000,
    ),
  );
  if (unblocked) say(`    tester got: ${envBrief(unblocked)}`);
  check(
    "5. the unblocked update is from @factory about T-2",
    unblocked?.from === "@factory" && unblocked.taskKey === "T-2",
    unblocked ? envBrief(unblocked) : "none",
  );
  const t2After = (await api("GET", "/api/tasks/T-2")).json() as {
    blockedBy: string[];
    status: string;
  };
  check(
    "5. GET /api/tasks/T-2 is no longer blocked",
    t2After.blockedBy.length === 0,
    JSON.stringify(t2After.blockedBy),
  );
  await step("5. dev and tester go quiet", () => quiet(["dev", "tester"]));
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
