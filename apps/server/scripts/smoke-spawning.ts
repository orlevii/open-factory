// Live spawning check for S7 (spec §17). Not part of `pnpm test`.
// Needs Postgres (pnpm compose up -d), a real `claude` on the host PATH (credential verification runs there), the OAuth
// token in ~/.open-factory-spike/oauth-token and, for Docker agents (the default), Docker with the local image
// open-factory-base:dev and the CLI bundle (pnpm build). `--local` runs the agents on the host instead
// (FACTORY_ALLOW_LOCAL_RUNTIME=true for this run only). The token is read from that file at run time into a factory
// credential and is never printed: everything this script prints goes through `redact`.
// Uses a throwaway database and a temp FACTORY_HOME; the human server and the agent listener listen on loopback.
// Model: haiku. FACTORY_MEMBER_UPDATE_DEBOUNCE_SECONDS=10 so the spawner hears from its child quickly.
// Org: `lead` (top, can_spawn: [helper], max_live_spawns: 2), which spawns `helper-one` and later terminates it.
// Part 1 (Task 10): one spawn, the brief, the child's text as a member_update, one terminate.
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
const CHILD = "helper-one";

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
const hostSkillsDir = path.join(root, "host-skills");
const WORD = `SPAWN-${randomBytes(3).toString("hex").toUpperCase()}`;

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
  const sent = await app.router.send(orUser, slug, body, false);
  if (!sent.ok) throw new Error(`send to ${slug} failed: ${sent.message}`);
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
const factoryTools = (tools: string[]) => tools.filter((t) => t.startsWith("mcp__factory__"));

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

const childRow = async () =>
  (
    await sql<
      { id: string; kind: string; reports_to: string | null; terminated_at: string | null }[]
    >`select id, kind, reports_to, terminated_at::text as terminated_at from agents where slug = ${CHILD}`
  )[0];

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
    FACTORY_HOST_SKILLS_DIR: hostSkillsDir,
    FACTORY_DEFAULT_IMAGE: IMAGE,
    FACTORY_ALLOW_LOCAL_RUNTIME: LOCAL ? "true" : "false",
    FACTORY_MEMBER_UPDATE_DEBOUNCE_SECONDS: "10",
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
  await step("0. credential created (live verification turn passed)", () =>
    app.credentials.create({ name: "smoke", kind: "oauth_token", value: token }),
  );
  await step(`0. templates lead and helper (${runtime}, haiku) are valid`, async () => {
    writeTemplate("lead", {
      "template.yaml": [
        "name: lead",
        "display_name: Lead",
        "description: Smoke spawning lead",
        `runtime: ${runtime}`,
        "model: haiku",
        "can_spawn: [helper]",
        "max_live_spawns: 2",
        "",
      ].join("\n"),
      "AGENTS.md": [
        "# Lead",
        "",
        "You are a smoke-test agent. Follow instructions literally and keep replies short.",
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
    const scanned = await app.templates.scan();
    for (const name of ["lead", "helper"]) {
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
    `4. ${CHILD}'s system/init lists neither ${SPAWN} nor ${TERMINATE}`,
    !childInit.tools.includes(SPAWN) && !childInit.tools.includes(TERMINATE),
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
  say(`    ${brief(JSON.stringify(ended.event))} at ${ended.at}`);
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
