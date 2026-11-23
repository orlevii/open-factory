// Live user-image check for S10 (spec §15.5, AC7). Not part of `pnpm test`.
// Needs Postgres (pnpm compose up -d), Docker with `ghcr.io/orlevii/open-factory/base:latest` pullable and the local-only
// `open-factory-base:dev`, a real `claude` on the host PATH (credential verification runs there), the CLI bundle
// (pnpm build) and the OAuth token in ~/.open-factory-spike/oauth-token. The token is read from that file at run time
// into a factory credential (POST /api/credentials) and is never printed: everything this script prints goes through
// `redact`. Model: haiku.
// It drives only real routes over a real socket (fetch against the listening app, and the built CLI with a real bearer
// token): no service calls, no test hooks. SQL is used only to read back a turn row for an assertion. A throwaway
// database and a temp FACTORY_HOME; the images it builds (open-factory-user/{smoke,local}:latest) and the agent's
// container are removed at the end.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createDb, MIGRATIONS_DIR, migrate } from "@open-factory/db";
import { createTestDatabase } from "@open-factory/db/testing";
import type { SessionEvent } from "@open-factory/shared";
import Docker from "dockerode";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { LABEL_AGENT_ID, LABEL_IMAGE } from "../src/runtime/docker/containers.ts";

const PULLABLE_BASE = "ghcr.io/orlevii/open-factory/base:latest";
const LOCAL_BASE = "open-factory-base:dev";
const USER_TAG = (name: string) => `open-factory-user/${name}:latest`;
const HASH_LABEL = "io.open-factory.context-hash";
const TOKEN_FILE = path.join(homedir(), ".open-factory-spike", "oauth-token");
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI = path.join(REPO, "apps/cli/dist/open-factory.js");
const ASK = "Reply with the word PELICAN and nothing else. Use no tools.";

let token = "";
try {
  token = readFileSync(TOKEN_FILE, "utf8").trim();
} catch {}
if (!token) {
  console.error(`No OAuth token in ${TOKEN_FILE}.`);
  process.exit(1);
}

// ---------- output (always redacted) ----------
const bearers: string[] = [];
const redact = (s: string) => {
  let out = s.split(token).join("[redacted]");
  for (const b of bearers) out = out.split(b).join("[bearer]");
  return (
    out
      .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]")
      .replace(/Bearer [A-Za-z0-9._-]{20,}/g, "Bearer [redacted]")
      .replace(/invite=[A-Za-z0-9_-]+/g, "invite=[redacted]")
      // A sign-up or sign-in body carries the new session's token.
      .replace(/"token":"[^"]*"/g, '"token":"[redacted]"')
  );
};
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
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "of-smoke-images-")));
const factoryHome = path.join(root, "home");
const hostSkillsDir = path.join(root, "host-skills");
const cliHome = path.join(root, "cli-home");
const WORD = randomBytes(3).toString("hex");

// ---------- server log capture (pino JSON lines, never printed raw) ----------
const pullLogs: string[] = [];
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
          image?: string;
        };
        // ContainerManager.ensureImage's line: the only place a registry pull starts.
        if (o.msg === "pulling image") pullLogs.push(String(o.image));
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

function cleanup(): Promise<void> {
  cleaned ??= (async () => {
    if (appBuilt) {
      let closeErr = "";
      await app.close().catch((e) => {
        closeErr = String(e);
      });
      if (closeErr) fail("cleanup: closing the app failed", closeErr);
    }
    // This run's agent container (by its agent-id label, so nothing else is touched), then the two images it built.
    if (agentId)
      try {
        const listed = await dk.listContainers({
          all: true,
          filters: { label: [`${LABEL_AGENT_ID}=${agentId}`] },
        });
        for (const c of listed) await dk.getContainer(c.Id).remove({ force: true });
      } catch (e) {
        console.error(redact(`cleanup: removing a container failed: ${e}`));
      }
    for (const name of ["smoke", "local"])
      try {
        await dk.getImage(USER_TAG(name)).remove({ force: true });
      } catch (e) {
        if (!String(e).includes("No such image"))
          console.error(`cleanup: removing ${USER_TAG(name)} failed: ${e}`);
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

let base = "";
let origin = "";
/** One real HTTP request to the listening app, as a cookie session or a bearer token. */
async function http(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  auth: { cookie?: string; bearer?: string },
  body?: object,
) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      origin,
      ...(auth.cookie ? { cookie: auth.cookie } : {}),
      ...(auth.bearer ? { authorization: `Bearer ${auth.bearer}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, text, json: json as Record<string, unknown>, headers: res.headers };
}
const expect = (r: { status: number; text: string }, status: number, what: string) => {
  if (r.status !== status)
    throw new Error(`${what}: expected ${status}, got ${r.status}: ${brief(r.text)}`);
};

async function signUp(handle: string, invite?: string) {
  return http(
    "POST",
    "/api/auth/sign-up/email",
    {},
    {
      ...(invite ? { invite } : {}),
      name: handle[0]?.toUpperCase() + handle.slice(1),
      handle,
      email: `${handle}-${WORD}@example.invalid`,
      password: `pw-${WORD}-${handle}-long`,
    },
  );
}
const cookieOf = (headers: Headers) =>
  headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
/** The bearer token better-auth's bearer plugin returns on sign-in (what `open-factory login` stores). */
async function signIn(handle: string) {
  const r = await http(
    "POST",
    "/api/auth/sign-in/email",
    {},
    {
      email: `${handle}-${WORD}@example.invalid`,
      password: `pw-${WORD}-${handle}-long`,
    },
  );
  expect(r, 200, `sign-in ${handle}`);
  const t = r.headers.get("set-auth-token");
  if (!t) throw new Error(`sign-in ${handle}: no set-auth-token header`);
  bearers.push(t);
  return t;
}

/** Runs the built CLI with OPEN_FACTORY_URL / OPEN_FACTORY_TOKEN; a fresh HOME so no stored config is read. */
function cli(args: string[], bearer: string) {
  return new Promise<{ code: number | null; out: string[]; err: string[] }>((resolve, reject) => {
    const p = spawn(process.execPath, [CLI, ...args], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: cliHome,
        OPEN_FACTORY_URL: base,
        OPEN_FACTORY_TOKEN: bearer,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => {
      out += String(d);
    });
    p.stderr.on("data", (d) => {
      err += String(d);
    });
    p.on("error", reject);
    p.on("close", (code) =>
      resolve({
        code,
        out: out.split("\n").filter(Boolean),
        err: err.split("\n").filter(Boolean),
      }),
    );
  });
}

let orCookie = "";
const or = () => ({ cookie: orCookie });
const events = async (): Promise<SessionEvent[]> => {
  const r = await http("GET", "/api/agents/smoke/events?limit=500", or());
  expect(r, 200, "GET /api/agents/smoke/events");
  return (r.json as { events: SessionEvent[] }).events;
};
const imageStatus = async (name: string) => {
  const r = await http("GET", "/api/images", or());
  expect(r, 200, "GET /api/images");
  const items = (r.json as { images: { name: string; status: string; builtAt?: string }[] }).images;
  return items.find((i) => i.name === name);
};
function writeFiles(dir: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
}

try {
  // 0. Setup (inside the try so a failure here still cleans up).
  const port = await freePort();
  const agentPort = await freePort();
  base = `http://127.0.0.1:${port}`;
  tdb = await createTestDatabase();
  await migrate(tdb.url, MIGRATIONS_DIR);
  const config = loadConfig({
    ...process.env,
    DATABASE_URL: tdb.url,
    FACTORY_SECRET_KEY: "s".repeat(40),
    FACTORY_HOME: factoryHome,
    FACTORY_HOST_SKILLS_DIR: hostSkillsDir,
    FACTORY_DEFAULT_IMAGE: LOCAL_BASE,
    FACTORY_ALLOW_LOCAL_RUNTIME: "false",
    HOST: "127.0.0.1",
    PORT: String(port),
    PUBLIC_URL: base,
    FACTORY_AGENT_PORT: String(agentPort),
    NODE_ENV: "development",
  });
  origin = config.publicOrigin;
  say(`Docker agents, model haiku; bases ${PULLABLE_BASE} (pullable) and ${LOCAL_BASE} (local)`);
  await step(
    "0. setup: prerequisites (CLI bundle, agent CLI bundle, local base image)",
    async () => {
      mkdirSync(hostSkillsDir, { recursive: true });
      mkdirSync(cliHome, { recursive: true });
      readFileSync(CLI);
      readFileSync(config.cliBundle);
      await dk.getImage(LOCAL_BASE).inspect();
      for (const name of ["smoke", "local"])
        await dk
          .getImage(USER_TAG(name))
          .inspect()
          .then(
            () => {
              throw new Error(`${USER_TAG(name)} already exists; remove it before the run`);
            },
            () => undefined,
          );
    },
  );
  const conn = createDb(tdb.url);
  closeDb = conn.close;
  app = await buildApp(config, {
    db: conn.db,
    sql: conn.sql,
    logger: { level: "debug", stream: logStream },
  });
  appBuilt = true;
  await app.listen({ host: config.host, port: config.port });
  say(`  human server ${base}; agent listener port ${app.agentListener.port}`);

  // ---- 1. bootstrap user, credential, image folder, template, agent ----
  await step("1. first user @or signs up without an invite (bootstrap) → 200", async () => {
    const r = await signUp("or");
    expect(r, 200, "sign-up or");
    orCookie = cookieOf(r.headers);
  });
  await step("1. POST /api/credentials smoke (oauth_token, verified live) → 201", async () => {
    const r = await http("POST", "/api/credentials", or(), {
      name: "smoke",
      kind: "oauth_token",
      value: token,
    });
    expect(r, 201, "POST /api/credentials");
  });
  const imagesRoot = path.join(factoryHome, "images");
  writeFiles(path.join(imagesRoot, "smoke"), {
    Dockerfile: `FROM ${PULLABLE_BASE}\nRUN echo smoke > /etc/smoke\n`,
  });
  writeFiles(path.join(factoryHome, "templates", "smoke-tpl"), {
    "template.yaml": [
      "name: smoke-tpl",
      "display_name: Smoke",
      "description: Smoke user-image template",
      "runtime: docker",
      "image: smoke",
      "model: haiku",
      "",
    ].join("\n"),
    "AGENTS.md":
      "# Smoke\n\nYou are a smoke-test agent. Follow instructions literally; keep replies short.\n",
  });
  await step(
    "1. template smoke-tpl (runtime docker, image smoke, haiku) is valid, image not_built",
    async () => {
      const r = await http("GET", "/api/templates", or());
      expect(r, 200, "GET /api/templates");
      const list = (
        r.json as { templates: { name: string; errors: number; imageStatus?: unknown }[] }
      ).templates;
      const t = list.find((x) => x.name === "smoke-tpl");
      if (!t) throw new Error(`smoke-tpl not listed: ${brief(r.text)}`);
      if (t.errors) throw new Error(`${t.errors} validation errors`);
      const s = t.imageStatus as { kind?: string; status?: string } | undefined;
      if (s?.kind !== "user" || s.status !== "not_built")
        throw new Error(`imageStatus ${JSON.stringify(t.imageStatus)}`);
      say(`    imageStatus: ${JSON.stringify(t.imageStatus)}`);
    },
  );
  await step("1. POST /api/agents smoke (template smoke-tpl) → 201", async () => {
    const r = await http("POST", "/api/agents", or(), {
      template: "smoke-tpl",
      slug: "smoke",
      displayName: "Smoke",
      description: "Smoke user-image agent",
      reportsTo: null,
      credential: "smoke",
    });
    expect(r, 201, "POST /api/agents");
    agentId = String((await conn.sql`select id from agents where slug = 'smoke'`)[0]?.id ?? "");
  });

  // ---- 2. a start before the build fails with the "isn't built" message, without a pull ----
  const notBuilt =
    "Image `smoke` isn't built. Build it in Templates → Images, or run `open-factory images build smoke`.";
  await step("2. message smoke before the build → 202", async () => {
    const r = await http("POST", "/api/messages", or(), {
      to: ["smoke"],
      // The same instruction as the later message: this one stays queued through the failed start and may be
      // delivered in the same batch.
      body: ASK,
    });
    expect(r, 202, "POST /api/messages");
  });
  const startErr = await step("2. the start fails: error event (source spawn)", () =>
    until(
      "the start error",
      async () =>
        (await events()).find((e) => e.event.type === "error" && e.event.source === "spawn"),
      60_000,
    ),
  );
  const ev = startErr.event as Extract<SessionEvent["event"], { type: "error" }>;
  check(
    '2. the error has fix "image" and the exact "isn\'t built" message',
    ev.fix === "image" && ev.message === notBuilt,
    `fix=${ev.fix}; message=${ev.message}`,
  );
  check(
    "2. no pull ran (no `pulling image` server log line)",
    pullLogs.length === 0,
    `pull log lines: ${JSON.stringify(pullLogs)}`,
  );

  // ---- 3. the CLI builds the image ----
  const orBearer = await step("3. @or signs in; bearer from the set-auth-token header", () =>
    signIn("or"),
  );
  const built = await step(
    "3. `open-factory images build smoke` (built CLI, bearer) exits 0",
    async () => {
      const r = await cli(["images", "build", "smoke"], orBearer);
      if (r.code !== 0)
        throw new Error(
          `exit ${r.code}; stderr: ${brief(r.err.join(" | "), 800)}; tail: ${brief(r.out.slice(-5).join(" | "), 600)}`,
        );
      return r;
    },
  );
  check(
    "3. the build log streamed to stdout",
    built.out.length > 2 && built.out.at(-1) === "Built smoke",
    `${built.out.length} lines; first: ${brief(built.out[0] ?? "", 120)}; last 3: ${brief(built.out.slice(-3).join(" | "), 300)}`,
  );
  const inspected = await dk.getImage(USER_TAG("smoke")).inspect();
  const hash = inspected.Config?.Labels?.[HASH_LABEL];
  check(
    `3. docker image inspect ${USER_TAG("smoke")} has ${HASH_LABEL}`,
    Boolean(hash),
    `${HASH_LABEL}=${hash}`,
  );
  const afterBuild = await imageStatus("smoke");
  check(
    "3. GET /api/images → smoke built",
    afterBuild?.status === "built",
    JSON.stringify(afterBuild),
  );

  // ---- 4. the agent starts on the user image and answers ----
  await step("4. POST /api/agents/smoke/restart → 202", async () => {
    const r = await http("POST", "/api/agents/smoke/restart", or());
    expect(r, 202, "POST /api/agents/smoke/restart");
  });
  const sent = await step("4. message smoke after the build → 202", async () => {
    const r = await http("POST", "/api/messages", or(), {
      to: ["smoke"],
      body: ASK,
    });
    expect(r, 202, "POST /api/messages");
    return String((r.json as { results: { id: string }[] }).results[0]?.id);
  });
  const turn = await step("4. smoke's turn for that message ends", () =>
    until(
      "smoke's turn",
      async () => {
        const es = await events();
        const i = es.findIndex(
          (e) =>
            e.event.type === "message_in" &&
            e.event.messages.some((m) => m.id === sent || m.ids?.includes(sent)),
        );
        if (i === -1) return undefined;
        const rest = es.slice(i);
        const end = rest.findIndex((e) => e.event.type === "turn_end" && !e.event.originKind);
        return end === -1 ? undefined : rest.slice(0, end + 1);
      },
      240_000,
      1000,
    ),
  );
  const answer = turn
    .flatMap((e) => (e.event.type === "assistant_text" ? [e.event.text] : []))
    .join(" ");
  check("4. smoke answers", /PELICAN/i.test(answer), `answer: ${brief(answer, 200)}`);
  const containers = await dk.listContainers({
    all: true,
    filters: { label: [`${LABEL_AGENT_ID}=${agentId}`] },
  });
  const label = containers[0]?.Labels?.[LABEL_IMAGE];
  check(
    `4. the container label ${LABEL_IMAGE} = ${USER_TAG("smoke")}`,
    containers.length === 1 && label === USER_TAG("smoke"),
    `containers: ${containers.length}; ${LABEL_IMAGE}=${label}; image=${containers[0]?.Image}`,
  );
  const usage = await http("GET", "/api/agents/smoke/usage?days=7", or());
  const total = (usage.json as { total?: { turns: number; costUsd: number } }).total;
  check(
    "4. GET /api/agents/smoke/usage?days=7 → turns ≥ 1",
    usage.status === 200 && (total?.turns ?? 0) >= 1,
    `status ${usage.status}; total ${JSON.stringify(total)}`,
  );
  const rows = await conn.sql`
    select t.credential_id, c.name from turns t left join credentials c on c.id = t.credential_id
    where t.agent_id = ${agentId}`;
  check(
    "4. the turn row has credential_id set (credential smoke)",
    rows.length >= 1 && rows.every((r) => r.credential_id && r.name === "smoke"),
    `turn rows: ${rows.length}; credentials: ${JSON.stringify(rows.map((r) => r.name))}`,
  );
  const creds = await http("GET", "/api/usage/credentials?days=7", or());
  const smokeCred = (
    creds.json as { credentials?: { name: string; rateLimit: unknown; totals: unknown }[] }
  ).credentials?.find((c) => c.name === "smoke");
  check(
    "4. GET /api/usage/credentials?days=7 shows smoke with a rateLimit (V5 in situ)",
    creds.status === 200 && Boolean(smokeCred?.rateLimit),
    `rateLimit ${JSON.stringify(smokeCred?.rateLimit)}; totals ${JSON.stringify(smokeCred?.totals)}`,
  );

  // ---- 5. a changed folder is out of date ----
  writeFileSync(path.join(imagesRoot, "smoke", "new.txt"), "new\n");
  const afterTouch = await imageStatus("smoke");
  check(
    "5. touch images/smoke/new.txt → GET /api/images → out_of_date",
    afterTouch?.status === "out_of_date",
    JSON.stringify(afterTouch),
  );

  // ---- 6. a local-only base needs --no-pull ----
  writeFiles(path.join(imagesRoot, "local"), {
    Dockerfile: `FROM ${LOCAL_BASE}\nRUN echo local > /etc/local\n`,
  });
  const noPull = await cli(["images", "build", "local", "--no-pull"], orBearer);
  check(
    "6. `images build local --no-pull` (FROM open-factory-base:dev) exits 0",
    noPull.code === 0 && noPull.out.at(-1) === "Built local",
    `exit ${noPull.code}; ${noPull.out.length} lines; last: ${brief(noPull.out.at(-1) ?? "", 120)}; stderr: ${brief(noPull.err.join(" | "), 300)}`,
  );
  const withPull = await cli(["images", "build", "local"], orBearer);
  const pullSentence = `Base image ${LOCAL_BASE} couldn't be pulled. If it's local-only, run \`open-factory images build local --no-pull\`.`;
  check(
    '6. `images build local` without --no-pull exits 1 with the "couldn\'t be pulled" sentence',
    withPull.code === 1 && withPull.err.join("\n").includes(pullSentence),
    `exit ${withPull.code}; stderr: ${brief(withPull.err.join(" | "), 400)}`,
  );

  // ---- 7. the invite flow and disable, over real HTTP ----
  const invite = await step("7. POST /api/invites → 201 with a link", async () => {
    const r = await http("POST", "/api/invites", or());
    expect(r, 201, "POST /api/invites");
    const t = new URL(String((r.json as { link: string }).link)).searchParams.get("invite");
    if (!t) throw new Error(`no invite token in the link: ${brief(r.text)}`);
    return t;
  });
  const noInvite = await signUp("kim");
  check(
    "7. sign-up without an invite → 403 invite_required",
    noInvite.status === 403 && noInvite.text.includes("invite_required"),
    `${noInvite.status} ${brief(noInvite.text, 200)}`,
  );
  const sam = await signUp("sam", invite);
  check(
    "7. sign-up @sam with the invite → 200",
    sam.status === 200,
    `${sam.status} user ${JSON.stringify((sam.json as { user?: { name?: string } }).user?.name)}`,
  );
  const reuse = await signUp("kim", invite);
  check(
    "7. reusing the invite → 403 invite_invalid",
    reuse.status === 403 && reuse.text.includes("invite_invalid"),
    `${reuse.status} ${brief(reuse.text, 200)}`,
  );
  const samBearer = await step("7. @sam signs in (bearer)", () => signIn("sam"));
  const meBefore = await http("GET", "/api/me", { bearer: samBearer });
  const samId = String((meBefore.json as { id?: string }).id ?? "");
  check(
    "7. @sam's bearer works before disable (GET /api/me → 200)",
    meBefore.status === 200,
    `status ${meBefore.status}`,
  );
  const disabled = await http("POST", `/api/users/${samId}/disable`, or());
  check(
    "7. @or disables @sam → 200",
    disabled.status === 200,
    `${disabled.status} ${brief(disabled.text, 200)}`,
  );
  const meAfter = await http("GET", "/api/me", { bearer: samBearer });
  check("7. @sam's bearer after disable → 401", meAfter.status === 401, `status ${meAfter.status}`);
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
