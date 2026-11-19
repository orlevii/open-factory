// Live workspace check for S4 (spec §18.4). Not part of `pnpm test`.
// Needs Postgres (pnpm compose up -d), a real `claude` on PATH and CLAUDE_CODE_OAUTH_TOKEN in the env.
// Uses a throwaway database, a temp FACTORY_HOME and a temp host skills dir; never touches ~/.claude
// or ~/open-factory. Builds everything through buildApp (logger off) and drives AgentService,
// CredentialService, ProjectService and the runtimes directly. Model: haiku. Never prints the token.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createDb, MIGRATIONS_DIR, migrate } from "@open-factory/db";
import { createTestDatabase } from "@open-factory/db/testing";
import { createClaudeDriver } from "@open-factory/harness";
import type { AnyEvent } from "@open-factory/shared";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { ApiError } from "../src/errors.ts";
import { agentConfigDir, agentWorkdir } from "../src/workspace/paths.ts";

const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
if (!token) {
  console.error(
    'Run with: CLAUDE_CODE_OAUTH_TOKEN="$(cat ~/.open-factory-spike/oauth-token)" pnpm smoke:workspace',
  );
  process.exit(1);
}

// ---------- output ----------
let failures = 0;
const ok = (name: string) => console.log(`✔ ${name}`);
const fail = (name: string, detail?: string) => {
  failures++;
  console.log(`✘ ${name}${detail ? `\n    ${detail}` : ""}`);
};
const check = (name: string, cond: boolean, detail?: string) =>
  cond ? ok(name) : fail(name, detail);
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
class StopRun extends Error {}

// ---------- temp dirs ----------
// realpath: macOS tmpdir is a /var symlink and Claude reports the resolved cwd.
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "of-smoke-ws-")));
const factoryHome = path.join(root, "home");
const hostSkillsDir = path.join(root, "host-skills");
const repoDir = path.join(root, "smoke-repo");
// The real host skills, by name only, to prove none of them leak into an agent's session.
const realHostSkills = (() => {
  try {
    return readdirSync(path.join(homedir(), ".claude", "skills"), { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name);
  } catch {
    return [];
  }
})();

// ---------- system/init capture (stdout lines reach the driver's debug log) ----------
interface Init {
  skills: string[];
  plugins: unknown[];
  cwd: string;
}
const inits = new Map<string, Init>();
const captureLog = {
  debug(o: { agent?: string; line?: string }) {
    if (!o.agent || o.agent === "verify" || typeof o.line !== "string") return;
    if (!o.line.includes('"subtype":"init"')) return;
    try {
      const j = JSON.parse(o.line);
      if (j.type === "system" && j.subtype === "init" && !inits.has(o.agent))
        inits.set(o.agent, {
          skills: Array.isArray(j.skills) ? j.skills.map(String) : [],
          plugins: Array.isArray(j.plugins) ? j.plugins : [],
          cwd: String(j.cwd ?? ""),
        });
    } catch {}
  },
  info() {},
  warn() {},
  error() {},
};

// ---------- app ----------
// Everything that needs cleanup is tracked here so the cleanup can run from any point: a failed
// setup, the end of the run, or SIGINT/SIGTERM. Each cleanup step is guarded on its own.
let app!: Awaited<ReturnType<typeof buildApp>>;
let appBuilt = false;
let tdb: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
let closeDb: (() => Promise<void>) | undefined;
let cleaned: Promise<void> | undefined;
function cleanup(): Promise<void> {
  cleaned ??= (async () => {
    if (appBuilt) {
      // app.close() runs runtimes.stopAll() (onClose hook); then no process may be running.
      try {
        const rts = await Promise.all(
          ["smoke-alpha", "smoke-beta"].map((s) => app.runtimes.bySlug(s).catch(() => undefined)),
        );
        let closeErr = "";
        await app.close().catch((e) => {
          closeErr = String(e);
        });
        const statuses = rts.map((r) => r?.live().status ?? "missing");
        check(
          "7. both runtimes stopped",
          !closeErr && statuses.every((st) => st === "hibernated"),
          `close: ${closeErr}; statuses: ${statuses.join(", ")}`,
        );
      } catch (e) {
        fail("cleanup: closing the app failed", String(e));
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
const events = new Map<string, AnyEvent[]>();
async function turn(slug: string, body: string, ms = 240_000): Promise<AnyEvent[]> {
  const list = events.get(slug) ?? [];
  const from = list.length;
  const rt = await app.runtimes.bySlug(slug);
  if (!rt) throw new Error(`no runtime for ${slug}`);
  await rt.sendMessage({ fromUserId: "smoke", fromHandle: "smoke", body, urgent: false });
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const got = list.slice(from);
    if (got.some((e) => e.type === "turn_end" && !e.originKind)) return got;
    if (got.some((e) => e.type === "exited")) throw new Error(`${slug} process exited mid-turn`);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${slug}: turn timed out`);
}
const textOf = (es: AnyEvent[]) =>
  es.flatMap((e) => (e.type === "assistant_text" ? [e.text] : [])).join("\n");
/** Plugins that aren't Claude Code's own built-ins (`path: "builtin"`), i.e. ones from a config dir. */
const hostPlugins = (i: Init | undefined) =>
  (i?.plugins ?? []).filter((p) => (p as { path?: unknown })?.path !== "builtin");
/** Tool calls and their results, for diagnosing a failed check. */
const toolTrace = (es: AnyEvent[]) =>
  es
    .flatMap((e) =>
      e.type === "tool_call"
        ? [`${e.name}(${brief(JSON.stringify(e.input)).slice(0, 160)})`]
        : e.type === "tool_result"
          ? [`→${e.isError ? " ERROR" : ""} ${brief(e.content).slice(0, 160)}`]
          : [],
    )
    .join(" | ");
const brief = (s: string) => s.replace(/\s+/g, " ").slice(0, 300);

function writeTemplate(name: string, files: Record<string, string>) {
  const dir = path.join(factoryHome, "templates", name);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
}

try {
  // 0. Setup (inside the try so a failure here still cleans up).
  mkdirSync(path.join(hostSkillsDir, "smoke-skill"), { recursive: true });
  writeFileSync(
    path.join(hostSkillsDir, "smoke-skill", "SKILL.md"),
    "---\nname: smoke-skill\ndescription: The smoke skill word. Use when asked for the smoke skill word.\n---\n\nReply PLOVER-SKILL when asked for the smoke skill word.\n",
  );
  tdb = await createTestDatabase();
  await migrate(tdb.url, MIGRATIONS_DIR);
  const conn = createDb(tdb.url);
  closeDb = conn.close;
  const config = loadConfig({
    ...process.env,
    DATABASE_URL: tdb.url,
    FACTORY_SECRET_KEY: "s".repeat(40),
    FACTORY_HOME: factoryHome,
    FACTORY_HOST_SKILLS_DIR: hostSkillsDir,
  });
  app = await buildApp(config, {
    db: conn.db,
    sql: conn.sql,
    logger: false,
    harnessDriver: createClaudeDriver(captureLog),
  });
  appBuilt = true;
  await conn.sql`insert into users (id, name, email, handle) values ('smoke', 'Smoke', 'smoke@example.invalid', 'smoke')`;
  for (const slug of ["smoke-alpha", "smoke-beta"]) {
    const list: AnyEvent[] = [];
    events.set(slug, list);
    app.bus.subscribe(slug, (m) => {
      if (m.type === "session_event") list.push(m.event.event);
    });
  }

  // 1. Credentials (each create runs the real verification turn).
  await step("1. credential smoke-a created (live verification turn passed)", () =>
    app.credentials.create({ name: "smoke-a", kind: "oauth_token", value: token }),
  );
  await step("1. credential smoke-b created (live verification turn passed)", () =>
    app.credentials.create({ name: "smoke-b", kind: "oauth_token", value: token }),
  );
  {
    // A made-up value, never the real one: verification must reject it and store nothing.
    let code = "accepted";
    try {
      await app.credentials.create({
        name: "smoke-bad",
        kind: "oauth_token",
        value: "sk-ant-oat01-smoke-invalid-value-0000000000",
      });
    } catch (err) {
      code = err instanceof ApiError ? `${err.status} ${err.code}` : String(err);
    }
    const names = (await app.credentials.list()).map((c) => c.name);
    check(
      "1. an invalid token is rejected (422 credential_rejected, no row)",
      code === "422 credential_rejected" && !names.includes("smoke-bad"),
      `got ${code}; credentials: ${names.join(", ")}`,
    );
  }

  // 2. Project.
  await step("2. temp git repo registered as project smoke-repo", async () => {
    mkdirSync(repoDir);
    writeFileSync(path.join(repoDir, "README.md"), "# smoke repo\n");
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repoDir, stdio: "ignore" });
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", "commit", "-qm", "init");
    return app.projects.create({ name: "smoke-repo", hostPath: repoDir });
  });

  // 3. Templates.
  await step("3. templates alpha and beta are valid", async () => {
    writeTemplate("alpha", {
      "template.yaml":
        "name: alpha\ndisplay_name: Alpha\ndescription: Smoke template alpha\nruntime: local\nmodel: haiku\nskills: [smoke-skill]\nprojects: [smoke-repo]\n",
      "AGENTS.md": "# Alpha\n\nYou are a smoke-test agent. Follow instructions literally.\n",
      "settings.json": JSON.stringify(
        { permissions: { deny: ["Bash(curl:*)", "Read(./secret.txt)"] } },
        null,
        2,
      ),
      "skills/alpha-only/SKILL.md":
        "---\nname: alpha-only\ndescription: A skill only alpha agents have.\n---\n\nSay ALPHA-ONLY.\n",
      "files/secret.txt": "SECRET-DO-NOT-READ\n",
    });
    writeTemplate("beta", {
      "template.yaml":
        "name: beta\ndisplay_name: Beta\ndescription: Smoke template beta\nruntime: local\nmodel: haiku\n",
      "AGENTS.md": "# Beta\n\nYou are a smoke-test agent.\n",
      "settings.json": JSON.stringify({ env: { BETA_MARK: "1" } }, null, 2),
    });
    const rows = await app.templates.scan();
    for (const n of ["alpha", "beta"]) {
      const r = rows.find((x) => x.name === n);
      const errs = r?.issues.filter((i) => i.severity === "error") ?? [];
      if (!r || errs.length) throw new Error(`${n}: ${JSON.stringify(errs)}`);
    }
  });

  // 4. Agents.
  const alpha = await step("4. agent smoke-alpha created from alpha with smoke-a", () =>
    app.agents.create({
      template: "alpha",
      slug: "smoke-alpha",
      displayName: "Smoke Alpha",
      description: "Smoke agent alpha",
      reportsTo: null,
      credential: "smoke-a",
    }),
  );
  await step("4. agent smoke-beta created from beta with smoke-b", () =>
    app.agents.create({
      template: "beta",
      slug: "smoke-beta",
      displayName: "Smoke Beta",
      description: "Smoke agent beta",
      reportsTo: "smoke-alpha",
      credential: "smoke-b",
    }),
  );
  check(
    "4. smoke-alpha holds the template default grant smoke-repo",
    alpha.projects.join(",") === "smoke-repo",
    `projects: ${alpha.projects.join(",")}`,
  );

  // 5. smoke-alpha turn.
  const a = await step("5. smoke-alpha turn completes", () =>
    turn(
      "smoke-alpha",
      [
        "Do these five things in order, each with a tool where one is needed, and keep going if one is denied:",
        "1) Say the smoke skill word (use the smoke-skill skill).",
        "2) With the Edit tool, edit the file at ./projects/smoke-repo/README.md (use that path, under your working directory; this check needs the main checkout, so no worktree) so it contains the text ALPHA-EDIT.",
        "3) Run this exact Bash command: curl -sI https://example.com",
        "4) Read the file ./secret.txt with the Read tool.",
        "5) Quote your slug and your manager line from your instructions, verbatim.",
      ].join("\n"),
    ),
  );
  const aInit = inits.get("smoke-alpha");
  const aSkills = aInit?.skills ?? [];
  check(
    "5. alpha system/init skills include smoke-skill and alpha-only",
    aSkills.includes("smoke-skill") && aSkills.includes("alpha-only"),
    `skills: ${aSkills.join(", ") || "(no init captured)"}`,
  );
  const leakedA = aSkills.filter((s) => realHostSkills.includes(s));
  check(
    "5. alpha system/init has none of the real host skills and only built-in plugins",
    Boolean(aInit) && leakedA.length === 0 && hostPlugins(aInit).length === 0,
    `leaked: ${leakedA.join(", ")}; plugins: ${JSON.stringify(hostPlugins(aInit))}`,
  );
  const readme = readFileSync(path.join(repoDir, "README.md"), "utf8");
  check(
    "5. edit through ./projects/smoke-repo reached the real repo (README has ALPHA-EDIT)",
    readme.includes("ALPHA-EDIT"),
    `README: ${brief(readme)}; tools: ${toolTrace(a)}`,
  );
  const edits = a.flatMap((e) =>
    e.type === "tool_call" && (e.name === "Edit" || e.name === "Write")
      ? [String((e.input as { file_path?: unknown })?.file_path ?? "")]
      : [],
  );
  const viaLink = path.join(agentWorkdir(factoryHome, "smoke-alpha"), "projects", "smoke-repo");
  check(
    "5. the Edit went through the ./projects/smoke-repo link",
    edits.some((f) => f.startsWith(`${viaLink}/`) || f.startsWith("./projects/smoke-repo/")),
    `Edit/Write paths: ${edits.join(", ") || "none"}`,
  );
  const denials = a.flatMap((e) => (e.type === "permission_denied" ? [e] : []));
  const denialsBrief = denials.map((d) => `${d.toolName}/${d.reasonType}`).join(", ") || "none";
  check(
    "5. Bash(curl:*) denial → permission_denied{reasonType: subcommandResults}",
    denials.some((d) => d.toolName === "Bash" && d.reasonType === "subcommandResults"),
    `denials: ${denialsBrief}`,
  );
  check(
    "5. Read(./secret.txt) denial → permission_denied{reasonType: rule}",
    denials.some((d) => d.toolName === "Read" && d.reasonType === "rule"),
    `denials: ${denialsBrief}`,
  );
  const aEnd = a.find((e) => e.type === "turn_end" && !e.originKind);
  check(
    "5. the turn continued past the denials and ended normally",
    aEnd?.type === "turn_end" && !aEnd.isError,
    JSON.stringify(aEnd),
  );
  const aText = textOf(a);
  check(
    "5. reply quotes the CLAUDE.md identity (@smoke-alpha, no manager)",
    aText.includes("@smoke-alpha") && /no manager/i.test(aText),
    `reply: ${brief(aText)}`,
  );
  check(
    "5. reply says the smoke skill word",
    aText.includes("PLOVER-SKILL"),
    `reply: ${brief(aText)}`,
  );
  check(
    "5. secret.txt content never reached the session",
    !a.some((e) => JSON.stringify(e).includes("SECRET-DO-NOT-READ")),
  );

  // 6. smoke-beta turn.
  const b = await step("6. smoke-beta turn completes", () =>
    turn(
      "smoke-beta",
      "List the names of the skills you have, then quote your slug and your manager line from your instructions.",
    ),
  );
  const bInit = inits.get("smoke-beta");
  const bSkills = bInit?.skills ?? [];
  check(
    "6. beta system/init has neither alpha-only nor smoke-skill",
    Boolean(bInit) && !bSkills.includes("alpha-only") && !bSkills.includes("smoke-skill"),
    `skills: ${bSkills.join(", ") || "(no init captured)"}`,
  );
  const leakedB = bSkills.filter((s) => realHostSkills.includes(s));
  check(
    "6. beta system/init has none of the real host skills and only built-in plugins",
    Boolean(bInit) && leakedB.length === 0 && hostPlugins(bInit).length === 0,
    `leaked: ${leakedB.join(", ")}; plugins: ${JSON.stringify(hostPlugins(bInit))}`,
  );
  const bText = textOf(b);
  check(
    "6. beta's reply names neither alpha-only nor smoke-skill",
    !bText.includes("alpha-only") && !bText.includes("smoke-skill"),
    `reply: ${brief(bText)}`,
  );
  check(
    "6. beta quotes its identity (@smoke-beta, manager @smoke-alpha)",
    bText.includes("@smoke-beta") && bText.includes("@smoke-alpha"),
    `reply: ${brief(bText)}`,
  );

  // 7. Config dirs.
  const dirs = ["smoke-alpha", "smoke-beta"].map((s) =>
    agentConfigDir(agentWorkdir(factoryHome, s)),
  );
  const [aDir = "", bDir = ""] = dirs;
  console.log(`  CLAUDE_CONFIG_DIR smoke-alpha: ${aDir}`);
  console.log(`  CLAUDE_CONFIG_DIR smoke-beta:  ${bDir}`);
  const aSettings = JSON.parse(readFileSync(path.join(aDir, "settings.json"), "utf8"));
  const bSettings = JSON.parse(readFileSync(path.join(bDir, "settings.json"), "utf8"));
  const aDeny: string[] = aSettings.permissions?.deny ?? [];
  const bDeny: string[] = bSettings.permissions?.deny ?? [];
  check(
    "7. separate config dirs with their own settings (alpha deny rules, beta BETA_MARK)",
    aDir !== bDir &&
      aDeny.includes("Bash(curl:*)") &&
      aDeny.includes("Read(./secret.txt)") &&
      !aSettings.env?.BETA_MARK &&
      bSettings.env?.BETA_MARK === "1" &&
      !bDeny.includes("Bash(curl:*)"),
    `alpha deny: ${aDeny.join(", ")}; beta env: ${JSON.stringify(bSettings.env ?? {})}`,
  );
  check(
    "7. each session ran in its own working directory",
    inits.get("smoke-alpha")?.cwd === agentWorkdir(factoryHome, "smoke-alpha") &&
      inits.get("smoke-beta")?.cwd === agentWorkdir(factoryHome, "smoke-beta"),
    `cwds: ${inits.get("smoke-alpha")?.cwd}, ${inits.get("smoke-beta")?.cwd}`,
  );
} catch (err) {
  if (!(err instanceof StopRun))
    fail("unexpected error", err instanceof Error ? err.stack : String(err));
} finally {
  await cleanup();
}

console.log(failures ? `\nSmoke FAILED (${failures} failed).` : "\nSmoke passed.");
process.exit(failures ? 1 : 0);
