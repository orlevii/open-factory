import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { schema } from "@open-factory/db";
import { createFakeClaude } from "@open-factory/harness/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { makeTestApp } from "../test/helpers.ts";
import type { AgentService } from "./agent-service.ts";
import type { AgentRuntimes } from "./runtimes.ts";

let t: Awaited<ReturnType<typeof makeTestApp>>;
let svc: AgentService;
let runtimes: AgentRuntimes;
let home: string;

const yaml = (name: string, extra = "") =>
  `name: ${name}\ndisplay_name: ${name}\nruntime: local\nprojects:\n  - app\n${extra}`;
function writeTemplate(name: string, y: string) {
  const d = path.join(home, "templates", name);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, "template.yaml"), y);
  writeFileSync(path.join(d, "AGENTS.md"), `# ${name}\n`);
}
const idOf = async (slug: string) => {
  const [r] = await t.db.select().from(schema.agents).where(eq(schema.agents.slug, slug));
  if (!r) throw new Error(`no agent ${slug}`);
  return r.id;
};

beforeAll(async () => {
  const fake = createFakeClaude({
    scenario: "reply",
    env: { FAKE_CLAUDE_PLUGIN_FAIL: "bad@mk" },
  });
  t = await makeTestApp({ env: { FACTORY_CLAUDE_BIN: fake.bin } });
  home = t.factoryHome;
  svc = t.app.agents;
  runtimes = t.app.runtimes;
  const repo = mkdtempSync(path.join(tmpdir(), "repo-"));
  await t.db.insert(schema.projects).values({ id: randomUUID(), name: "app", hostPath: repo });
  const credId = randomUUID();
  await t.db.insert(schema.credentials).values({
    id: credId,
    name: "work",
    kind: "oauth_token",
    valueEnc: t.app.vault.seal("tok", `credentials:${credId}`),
  });
  writeTemplate("lead", yaml("lead"));
  writeTemplate("plugged", yaml("plugged", "plugins:\n  - bad@mk\n"));
  writeFileSync(
    path.join(home, "templates/plugged/settings.json"),
    JSON.stringify({
      extraKnownMarketplaces: { mk: { source: { source: "directory", path: "/mk" } } },
    }),
  );
  writeTemplate("broken", "name: broken\nruntime: nonsense\n");
});
afterAll(() => t.close());

test("create: layout on disk, rows, grants default; then summary in tree order", async () => {
  const a = await svc.create({
    template: "lead",
    slug: "lead",
    displayName: "Lead",
    description: "",
    reportsTo: null,
    credential: "work",
  });
  expect(a).toMatchObject({
    slug: "lead",
    template: "lead",
    runtime: "local",
    credential: "work",
    projects: ["app"],
    grantsOverridden: false,
    depth: 0,
    archivedAt: null,
  });
  expect(existsSync(path.join(home, "agents/lead/AGENTS.md"))).toBe(true);
  const b = await svc.create({
    template: "lead",
    slug: "dev-1",
    displayName: "Dev",
    description: "",
    reportsTo: "lead",
    credential: "work",
    projects: [],
  });
  expect(b).toMatchObject({ projects: [], grantsOverridden: true, depth: 1 });
  expect((await svc.list("exclude")).map((x) => x.slug)).toEqual(["lead", "dev-1"]);
});

test.each([
  ["slug taken", { slug: "lead" }, { code: "slug_taken" }],
  ["reserved slug", { slug: "humans" }, { code: "validation_error" }],
  [
    "unknown credential",
    { credential: "nope" },
    { code: "validation_error", extra: { fields: { credential: expect.any(String) } } },
  ],
  [
    "unknown project",
    { projects: ["web"] },
    { code: "validation_error", extra: { fields: { projects: expect.any(String) } } },
  ],
  ["unknown manager", { reportsTo: "ghost" }, { code: "validation_error" }],
  ["invalid template", { template: "broken" }, { code: "template_invalid" }],
])("create rejects: %s", async (_n, patch, err) => {
  await expect(
    svc.create({
      template: "lead",
      slug: "x-new",
      displayName: "X",
      description: "",
      reportsTo: null,
      credential: "work",
      ...patch,
    }),
  ).rejects.toMatchObject(err);
});

test("create race on one slug: one wins, the loser leaves the winner's folder intact", async () => {
  const body = {
    template: "lead",
    slug: "racer",
    displayName: "R",
    description: "",
    reportsTo: null,
    credential: "work",
  };
  const r = await Promise.allSettled([svc.create(body), svc.create(body)]);
  expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(existsSync(path.join(home, "agents/racer/AGENTS.md"))).toBe(true);
});

test("create: plugin failure removes the folder and inserts no row; existing folder → folder_exists, untouched", async () => {
  await expect(
    svc.create({
      template: "plugged",
      slug: "plug",
      displayName: "P",
      description: "",
      reportsTo: null,
      credential: "work",
    }),
  ).rejects.toMatchObject({ code: "plugin_install_failed" });
  expect(existsSync(path.join(home, "agents/plug"))).toBe(false);
  expect((await svc.list("include")).map((a) => a.slug)).not.toContain("plug");
  mkdirSync(path.join(home, "agents/occupied"), { recursive: true });
  writeFileSync(path.join(home, "agents/occupied/keep.txt"), "k");
  await expect(
    svc.create({
      template: "lead",
      slug: "occupied",
      displayName: "O",
      description: "",
      reportsTo: null,
      credential: "work",
    }),
  ).rejects.toMatchObject({ code: "folder_exists" });
  expect(existsSync(path.join(home, "agents/occupied/keep.txt"))).toBe(true);
});

test("update: cycle rejected; projects null resets", async () => {
  await expect(svc.update("lead", { reportsTo: "dev-1" })).rejects.toMatchObject({
    message: "That would make @lead report to itself through @dev-1.",
  });
  await svc.update("dev-1", { projects: null });
  expect((await svc.summary("dev-1")).grantsOverridden).toBe(false);
});

test("update: a rename restarts the agent and exactly its direct reports", async () => {
  const spy = vi.spyOn(runtimes, "requestRestart");
  try {
    await svc.update("lead", { displayName: "Lead 2" });
    expect(spy.mock.calls.map((c) => c[0]).sort()).toEqual(
      [await idOf("lead"), await idOf("dev-1")].sort(),
    );
    spy.mockClear();
    // A feed-only change (grants) restarts the agent itself and leaves its reports alone.
    await svc.update("lead", { projects: [] });
    expect(spy.mock.calls.map((c) => c[0])).toEqual([await idOf("lead")]);
    await svc.update("lead", { projects: null });
  } finally {
    spy.mockRestore();
  }
});

test("projects: duplicate names are deduped (order kept) on create and PATCH", async () => {
  const made = await svc.create({
    template: "lead",
    slug: "dupe",
    displayName: "D",
    description: "",
    reportsTo: null,
    credential: "work",
    projects: ["app", "app"],
  });
  expect(made.projects).toEqual(["app"]);
  await svc.update("dupe", { projects: [] });
  expect((await svc.update("dupe", { projects: ["app", "app"] })).projects).toEqual(["app"]);
});

test("resync: backup dir, runtime column, grants follow unless overridden; refused when archived", async () => {
  writeFileSync(path.join(home, "agents/lead/AGENTS.md"), "edited");
  writeFileSync(
    path.join(home, "templates/lead/template.yaml"),
    "name: lead\ndisplay_name: Lead\nruntime: local\nprojects: []\n",
  );
  const r = await svc.resync("lead");
  expect(r.backupDir).toMatch(/^\.factory\/resync\//);
  expect(r.agent.projects).toEqual([]);
});

test("archive is blocked while active reports exist", async () => {
  await expect(svc.archive("lead")).rejects.toMatchObject({
    code: "has_reports",
    message: "@dev-1 reports to this agent. Change their manager first.",
  });
});

test("archive hides, refuses re-sync, allows PATCH; unarchive restores", async () => {
  await svc.archive("dev-1");
  expect((await svc.list("only")).map((a) => a.slug)).toEqual(["dev-1"]);
  expect((await svc.list("exclude")).map((a) => a.slug)).not.toContain("dev-1");
  await expect(svc.resync("dev-1")).rejects.toMatchObject({ code: "agent_archived" });
  expect((await svc.update("dev-1", { description: "parked" })).description).toBe("parked");
  expect((await svc.unarchive("dev-1")).archivedAt).toBeNull();
});

test("unarchive is refused while the manager is archived", async () => {
  await svc.update("dev-1", { reportsTo: null });
  await svc.create({
    template: "lead",
    slug: "helper",
    displayName: "Helper",
    description: "",
    reportsTo: "dev-1",
    credential: "work",
  });
  await svc.archive("helper");
  await svc.archive("dev-1");
  await expect(svc.unarchive("helper")).rejects.toMatchObject({
    code: "manager_archived",
    message: "Its manager @dev-1 is archived. Change its manager first.",
  });
});
