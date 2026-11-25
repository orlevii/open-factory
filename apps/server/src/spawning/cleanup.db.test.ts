import type { ProjectResult } from "@open-factory/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { EventStore } from "../agents/event-store.ts";
import { insertAgent } from "../agents/testing/rows.ts";
import { claimTestHandleSql } from "../test/handles.ts";
import { createTestDb } from "../test/helpers.ts";
import { SpawnCleanup } from "./cleanup.ts";
import { GitError, GitMissingError, GitTooOldError } from "./git.ts";

let t: Awaited<ReturnType<typeof createTestDb>>;
let store: EventStore;
const published: unknown[] = [];
const adopted: { agent: string; row: string }[] = [];
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

type Fake = (p: { name: string; hostPath: string }, slug: string) => Promise<ProjectResult | null>;
const make = (cleanupProject: Fake) =>
  new SpawnCleanup({
    db: t.db,
    store,
    bus: { publishAll: (m: unknown) => void published.push(m) } as never,
    runtimes: {
      adoptNotice: async (agent: string, row: string) => void adopted.push({ agent, row }),
    },
    log,
    cleanupProject,
  });

const kept: ProjectResult = {
  project: "web",
  removed: true,
  deleted: [],
  kept: [{ branch: "feat/x", commits: 3 }],
};
const removedOnly: ProjectResult = { project: "web", removed: true, deleted: ["feat/y"], kept: [] };

const agentRow = async (id: string) => {
  const row = await store.agentById(id);
  if (!row) throw new Error("no agent");
  return row;
};
const events = (id: string) =>
  t.sql`select seq, payload from session_events where agent_id = ${id} and type = 'workspace_cleanup'`;
const notices = () =>
  t.sql`select id, kind, notice, subject_agent_id, to_agent_id, body from messages where notice = 'worktrees_kept' order by created_at`;

beforeAll(async () => {
  t = await createTestDb();
  store = new EventStore(t.db);
  await claimTestHandleSql(t.sql, "or", "user");
  await t.sql`insert into users (id, name, email, handle) values ('u1', 'Or', 'or@x.io', 'or')`;
  await insertAgent(t.sql, { id: "boss", slug: "boss" });
  await insertAgent(t.sql, { id: "gone", slug: "gone", archived: true });
  await insertAgent(t.sql, {
    id: "dev",
    slug: "dev-ab12",
    reportsTo: "boss",
    terminatedAt: new Date(),
  });
  await insertAgent(t.sql, {
    id: "dead",
    slug: "dead",
    reportsTo: "boss",
    terminatedAt: new Date(),
  });
  await insertAgent(t.sql, {
    id: "orphan2",
    slug: "dev-ef56",
    reportsTo: "dead",
    terminatedAt: new Date(),
  });
  await insertAgent(t.sql, {
    id: "orphan",
    slug: "dev-cd34",
    reportsTo: "gone",
    terminatedAt: new Date(),
  });
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.sql`delete from messages`;
  await t.sql`delete from session_events`;
  await t.sql`delete from projects`;
  await t.sql`insert into projects (id, name, host_path) values ('p1', 'web', '/srv/web'), ('p2', 'docs', '/srv/docs'), ('p3', 'zed', '/srv/zed')`;
  published.length = 0;
  adopted.length = 0;
  for (const f of Object.values(log)) f.mockClear();
});

describe("SpawnCleanup.run", () => {
  test("scans every registered project in name order, whatever the agent was granted", async () => {
    const seen: string[] = [];
    await make(async (p, slug) => {
      seen.push(`${p.name}:${p.hostPath}:${slug}`);
      return null;
    }).run(await agentRow("dev"));
    expect(seen).toEqual([
      "docs:/srv/docs:dev-ab12",
      "web:/srv/web:dev-ab12",
      "zed:/srv/zed:dev-ab12",
    ]);
  });

  test("a kept branch records the event, tells the humans and the live manager", async () => {
    await make(async (p) => (p.name === "web" ? kept : null)).run(await agentRow("dev"));
    const [ev] = await events("dev");
    expect(ev?.payload).toEqual({ projects: [kept] });
    const rows = await notices();
    const human = rows.find((r) => r.to_agent_id === null);
    expect(human).toMatchObject({ kind: "system", subject_agent_id: "dev" });
    expect(human?.body).toBe(
      "Cleaned up @dev-ab12's worktrees.\nweb: kept `feat/x` (3 commits not pushed or merged)",
    );
    const items = await t.sql`select user_id from inbox_items where message_id = ${human?.id}`;
    expect(items.map((i) => i.user_id)).toEqual(["u1"]);
    expect(published).toContainEqual({ type: "inbox_changed" });
    const mgr = rows.find((r) => r.to_agent_id === "boss");
    expect(mgr?.body).toBe(human?.body);
    expect(adopted).toEqual([{ agent: "boss", row: mgr?.id }]);
  });

  test.each([
    ["archived", "orphan"],
    ["terminated", "orphan2"],
  ])("a %s manager gets nothing", async (_state, id) => {
    await make(async () => kept).run(await agentRow(id));
    const rows = await notices();
    expect(rows.map((r) => r.to_agent_id)).toEqual([null]);
    expect(adopted).toEqual([]);
  });

  test("removals only: the event is appended and nobody is told", async () => {
    await make(async () => removedOnly).run(await agentRow("dev"));
    expect(await events("dev")).toHaveLength(1);
    expect(await notices()).toHaveLength(0);
    expect(published).toEqual([]);
  });

  test("nothing of ours anywhere: no event, no notice", async () => {
    await make(async () => null).run(await agentRow("dev"));
    expect(await events("dev")).toHaveLength(0);
    expect(await notices()).toHaveLength(0);
  });

  test("a throwing project is reported by a short sentence and the others still run", async () => {
    const err = Object.assign(
      new Error("EACCES: permission denied, scandir '/srv/docs/.git/worktrees'"),
      {
        code: "EACCES",
      },
    );
    await make(async (p) => {
      if (p.name === "docs") throw err;
      return p.name === "web" ? removedOnly : null;
    }).run(await agentRow("dev"));
    const [ev] = await events("dev");
    expect(ev?.payload).toEqual({
      projects: [
        {
          project: "docs",
          removed: false,
          deleted: [],
          kept: [],
          error: "couldn't clean up: EACCES",
        },
        removedOnly,
      ],
    });
    const [n] = await notices();
    expect(n?.body).toContain("docs: couldn't clean up: EACCES");
    expect(n?.body).not.toContain("/srv");
  });

  test("an unknown error is cleaned of host paths and capped", async () => {
    await make(async () => {
      throw new Error(`boom at /home/me/secret/place ${"x".repeat(500)}\nsecond line`);
    }).run(await agentRow("dev"));
    const [ev] = await events("dev");
    const [first] = (ev?.payload as { projects: ProjectResult[] } | undefined)?.projects ?? [];
    const error = first?.error ?? "";
    expect(error).toMatch(/^couldn't clean up: /);
    expect(error).not.toContain("/home/me");
    expect(error).not.toContain("second line");
    expect(error.length).toBeLessThan(160);
  });

  test("an escaped GitError names the subcommand and nothing else", async () => {
    await make(async (p) => {
      if (p.name === "docs")
        throw new GitError(
          ["worktree", "list", "--porcelain", "-z"],
          "fatal: not a git repository: /srv/x/.git",
          128,
        );
      return null;
    }).run(await agentRow("dev"));
    const [ev] = await events("dev");
    const projects = (ev?.payload as { projects: ProjectResult[] } | undefined)?.projects ?? [];
    expect(projects[0]?.error).toBe("couldn't clean up: git worktree failed");
    const [n] = await notices();
    expect(n?.body).toBe(
      "Couldn't fully clean up @dev-ab12's worktrees.\ndocs: couldn't clean up: git worktree failed",
    );
  });

  test("an error mentioning a path with spaces leaks no fragment of it", async () => {
    await make(async () => {
      throw new Error("cannot open /Users/me/My Projects/secret thing/x");
    }).run(await agentRow("dev"));
    const [ev] = await events("dev");
    const projects = (ev?.payload as { projects: ProjectResult[] } | undefined)?.projects ?? [];
    const error = projects[0]?.error ?? "";
    for (const bit of ["Users", "Projects", "secret", "/"]) expect(error).not.toContain(bit);
  });

  test.each([
    [
      new GitMissingError(),
      "Couldn't clean up worktrees: git isn't installed on the factory host.",
      "missing",
    ],
    [
      new GitTooOldError("2.39.0"),
      "Couldn't clean up worktrees: git 2.44 or newer is needed on the factory host.",
      "too_old",
    ],
  ])("%s is one host line, and the scan stops", async (e, line, host) => {
    const calls: string[] = [];
    await make(async (p) => {
      calls.push(p.name);
      if (p.name === "web") throw e;
      return p.name === "docs" ? removedOnly : null;
    }).run(await agentRow("dev"));
    expect(calls).toEqual(["docs", "web"]); // "zed" sorts after "web" and is never called
    const [n] = await notices();
    expect(n?.body).toBe(["Couldn't fully clean up @dev-ab12's worktrees.", line].join("\n"));
    const [ev] = await events("dev");
    expect(ev?.payload).toEqual({ projects: [removedOnly], host });
  });

  test("the host line alone still records the event, so a retry doesn't tell twice", async () => {
    const run = make(async () => {
      throw new GitMissingError();
    });
    await run.run(await agentRow("dev"));
    await run.run(await agentRow("dev"));
    const [ev] = await events("dev");
    expect(ev?.payload).toEqual({ projects: [], host: "missing" });
    expect(await events("dev")).toHaveLength(1);
    expect(await notices()).toHaveLength(2); // one human, one manager: not four
  });

  test("a second run for the same agent appends no second event and sends no second notice", async () => {
    const run = make(async () => kept);
    await run.run(await agentRow("dev"));
    await run.run(await agentRow("dev"));
    expect(await events("dev")).toHaveLength(1);
    expect(await notices()).toHaveLength(2);
    expect(adopted).toHaveLength(1);
  });

  test("never rejects: a failing store write is logged", async () => {
    const run = new SpawnCleanup({
      db: t.db,
      store: {
        append: async () => {
          throw new Error("db down");
        },
      } as never,
      bus: { publishAll: () => {} } as never,
      runtimes: { adoptNotice: async () => {} },
      log,
      cleanupProject: async () => kept,
    });
    await expect(run.run(await agentRow("dev"))).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalled();
  });

  test("never rejects: a failing project list is logged", async () => {
    const run = new SpawnCleanup({
      db: {
        select: () => {
          throw new Error("db down");
        },
      } as never,
      store,
      bus: { publishAll: () => {} } as never,
      runtimes: { adoptNotice: async () => {} },
      log,
      cleanupProject: async () => kept,
    });
    await expect(run.run(await agentRow("dev"))).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalled();
  });

  test("the human's inbox item carries the cleanup event; the host line and an empty project list survive", async () => {
    await make(async () => kept).run(await agentRow("dev"));
    await make(async () => {
      throw new GitMissingError();
    }).run(await agentRow("dead"));
    const page = await store.inboxPage("u1");
    const byAbout = (about: string) => page.items.find((i) => i.about === about);
    expect(byAbout("dev-ab12")?.cleanup).toEqual({ projects: [kept, kept, kept] });
    expect(byAbout("dead")?.cleanup).toEqual({ projects: [], host: "missing" });
  });
});
