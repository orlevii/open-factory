import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { schema } from "@open-factory/db";
import type { ServerMessage } from "@open-factory/shared";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test } from "vitest";
import { makeAcmeMarketplace } from "../library/testing/acme-marketplace.ts";
import { makeFixtureRepo } from "../library/testing/fixture-repo.ts";
import { mcpCall } from "../mcp/testing/mcp-client.ts";
import { makeTestApp, signUp } from "../test/helpers.ts";

/** I5 §9, §11.1: the Library REST surface, human session only. */
let h: Awaited<ReturnType<typeof makeTestApp>>;
let or: Awaited<ReturnType<typeof signUp>>;
let tmp: string;
let frames: ServerMessage[];

const md = (name: string, extra = "") =>
  `---\nname: ${name}\ndescription: about ${name}\n${extra}---\n# ${name}\n`;

beforeEach(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "of-libroutes-"));
  h = await makeTestApp({ env: { FACTORY_GITHUB_URL: `file://${tmp}/gh` } });
  or = await signUp(h.app, { handle: "or" });
  frames = [];
  h.app.bus.subscribeAll((m) => frames.push(m));
  const tdd = path.join(h.hostSkillsDir, "tdd");
  mkdirSync(tdd);
  writeFileSync(path.join(tdd, "SKILL.md"), md("tdd"));
  writeFileSync(path.join(tdd, "notes.txt"), "plain notes\n");
  writeFileSync(path.join(tdd, "blob.bin"), Buffer.from([0, 1, 2, 3]));
  writeFileSync(path.join(tmp, "outside.txt"), "outside\n");
  symlinkSync(path.join(tmp, "outside.txt"), path.join(tdd, "link.txt"));
  writeFileSync(path.join(tdd, "run.sh"), "#!/bin/sh\n");
  chmodSync(path.join(tdd, "run.sh"), 0o755);
});
afterEach(() => h.close());

const call = (method: "GET" | "POST" | "DELETE", url: string, payload?: object) =>
  h.app.inject({
    method,
    url,
    headers: { cookie: or.cookie },
    ...(payload ? { payload } : {}),
  });
const libraryChanges = () => frames.filter((f) => f.type === "library_changed").length;

/** A folder source of two skills outside the factory's folders. */
function folderOfSkills() {
  const root = path.join(tmp, "skills-folder");
  for (const n of ["alpha", "beta"]) {
    mkdirSync(path.join(root, n), { recursive: true });
    writeFileSync(path.join(root, n, "SKILL.md"), md(n));
  }
  return root;
}

const ID = "11111111-1111-4111-8111-111111111111";
const ROUTES: Array<["GET" | "POST" | "DELETE", string, object?]> = [
  ["GET", "/api/library/skills"],
  ["GET", "/api/library/skills/host/tdd"],
  ["GET", "/api/library/skills/host/tdd/file?path=notes.txt"],
  ["GET", `/api/library/sources/${ID}`],
  ["POST", "/api/library/sources/preview", { kind: "folder", path: "/tmp/x" }],
  ["POST", "/api/library/sources", { kind: "folder", path: "/tmp/x", skills: ["a"] }],
  ["POST", `/api/library/sources/${ID}/find`],
  ["POST", `/api/library/sources/${ID}/add`, { skills: ["a"] }],
  ["POST", `/api/library/sources/${ID}/check`],
  ["POST", `/api/library/sources/${ID}/update`, { commit: "a".repeat(40) }],
  ["POST", `/api/library/sources/${ID}/fetch`],
  ["POST", `/api/library/sources/${ID}/restore`],
  ["POST", "/api/library/check"],
  ["DELETE", `/api/library/sources/${ID}`],
  ["GET", "/api/library/plugins"],
  ["GET", "/api/library/plugins/rel@acme"],
  ["GET", "/api/library/plugins/rel@acme/file?path=a.js"],
  ["GET", "/api/library/marketplaces"],
  ["GET", "/api/library/marketplaces/acme"],
  ["POST", "/api/library/marketplaces/preview", { kind: "github", repo: "acme/mk" }],
  ["POST", "/api/library/marketplaces", { previewId: ID }],
  ["POST", "/api/library/marketplaces/acme/check"],
  ["POST", "/api/library/marketplaces/acme/update", { commit: "a".repeat(40) }],
  ["POST", "/api/library/marketplaces/acme/fetch", { ref: "a".repeat(40) }],
  ["POST", "/api/library/marketplaces/acme/restore"],
  ["DELETE", "/api/library/marketplaces/acme"],
  ["POST", "/api/library/plugins/rel@acme/diff", { from: "a".repeat(40), to: "b".repeat(40) }],
  ["POST", "/api/library/plugins/rel@acme/read", {}],
  ["POST", "/api/library/host-plugins/rel@acme/add-marketplace"],
];

test.each(ROUTES)(
  "%s %s: no session and an agent token both get 401",
  async (method, url, payload) => {
    const lead = await h.seedAgent({ slug: "lead" });
    const { token } = h.app.agentTokens.mint(lead.id);
    const anon = await h.app.inject({ method, url, ...(payload ? { payload } : {}) });
    expect(anon.statusCode).toBe(401);
    const agent = await h.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload ? { payload } : {}),
    });
    expect(agent.statusCode).toBe(401);
  },
);

test("the factory MCP server lists no Library tool to an agent", async () => {
  const lead = await h.seedAgent({ slug: "lead" });
  const { token } = h.app.agentTokens.mint(lead.id);
  const r = await mcpCall(`http://127.0.0.1:${h.app.agentListener.port}`, token, "tools/list", {});
  const names = (r.json.result.tools as { name: string }[]).map((t) => t.name);
  expect(names.length).toBeGreaterThan(0);
  expect(names.filter((n) => /librar|skill|source|plugin|marketplace/.test(n))).toEqual([]);
});

test("GET /api/library/skills lists the host group with descriptions and the host dir", async () => {
  const r = await call("GET", "/api/library/skills");
  expect(r.statusCode).toBe(200);
  const body = r.json();
  expect(body.hostDir).toBe(h.config.hostClaudeDir);
  expect(path.join(body.hostDir, "skills")).toBe(h.hostSkillsDir);
  expect(body.groups[0]).toMatchObject({
    group: "host",
    kind: "host",
    skills: [
      { name: "tdd", description: "about tdd", state: "ok", usedBy: { templates: 0, agents: 0 } },
    ],
  });
});

test("a skill's detail lists its files, marks executables and carries SKILL.md", async () => {
  const r = await call("GET", "/api/library/skills/host/tdd");
  expect(r.statusCode).toBe(200);
  const d = r.json();
  expect(d.skillMd).toContain("# tdd");
  expect(d.files).toContainEqual({ path: "run.sh", executable: true });
  expect(d.files).toContainEqual({ path: "notes.txt", executable: false });
  expect((await call("GET", "/api/library/skills/host/nope")).statusCode).toBe(404);
});

test("the file route serves text and refuses a link, a binary and a path outside the skill", async () => {
  const file = (p: string) =>
    call("GET", `/api/library/skills/host/tdd/file?path=${encodeURIComponent(p)}`);
  const ok = await file("notes.txt");
  expect(ok.json()).toEqual({ path: "notes.txt", text: "plain notes\n" });
  for (const p of ["link.txt", "blob.bin", "../outside.txt", "/etc/passwd"]) {
    const r = await file(p);
    expect({ p, status: r.statusCode }).toEqual({ p, status: 400 });
    expect(r.json().error.fields.path).toEqual(expect.any(String));
    expect(r.body).not.toContain("outside");
  }
});

test("adding a folder source lists it, publishes library_changed and survives a 409 on a taken name", async () => {
  const root = folderOfSkills();
  const preview = await call("POST", "/api/library/sources/preview", {
    kind: "folder",
    path: root,
  });
  expect(preview.json().found.map((f: { name: string }) => f.name)).toEqual(["alpha", "beta"]);
  const before = libraryChanges();
  const added = await call("POST", "/api/library/sources", {
    kind: "folder",
    path: root,
    skills: ["alpha"],
  });
  expect(added.statusCode).toBe(201);
  expect(libraryChanges()).toBeGreaterThan(before);
  const id = added.json().id as string;

  const list = (await call("GET", "/api/library/skills")).json();
  expect(list.groups.find((g: { group: string }) => g.group === `source:${id}`)).toMatchObject({
    kind: "source",
    source: { id, kind: "folder", skillCount: 1 },
    skills: [{ name: "alpha", state: "ok" }],
  });
  expect((await call("GET", `/api/library/sources/${id}`)).json()).toMatchObject({
    id,
    skills: ["alpha"],
    update: null,
  });

  // Find more skills at the same folder, then add the other one.
  const more = await call("POST", `/api/library/sources/${id}/find`);
  expect(more.json().found).toContainEqual(
    expect.objectContaining({ name: "beta", pickable: true }),
  );
  const grown = await call("POST", `/api/library/sources/${id}/add`, { skills: ["beta"] });
  expect(grown.json().skills).toEqual(["alpha", "beta"]);

  const again = await call("POST", "/api/library/sources", {
    kind: "folder",
    path: root,
    skills: ["alpha"],
  });
  expect(again.statusCode).toBe(409);
});

test("a folder that is the factory's own is refused with a field error", async () => {
  const r = await call("POST", "/api/library/sources/preview", {
    kind: "folder",
    path: h.factoryHome,
  });
  expect(r.statusCode).toBe(400);
  expect(r.json().error.fields.path).toEqual(expect.any(String));
});

test("removing a source answers undoUntil and publishes; Undo restores it, then it expires", async () => {
  const root = folderOfSkills();
  const id = (
    await call("POST", "/api/library/sources", { kind: "folder", path: root, skills: ["alpha"] })
  ).json().id as string;
  const before = libraryChanges();
  const removed = await call("DELETE", `/api/library/sources/${id}`);
  expect(removed.statusCode).toBe(200);
  expect(Date.parse(removed.json().undoUntil)).toBeGreaterThan(Date.now());
  expect(libraryChanges()).toBeGreaterThan(before);
  expect((await call("GET", `/api/library/sources/${id}`)).statusCode).toBe(404);

  const restored = await call("POST", `/api/library/sources/${id}/restore`);
  expect(restored.statusCode).toBe(200);
  expect(restored.json().id).toBe(id);
  expect((await call("GET", `/api/library/sources/${id}`)).statusCode).toBe(200);

  await call("DELETE", `/api/library/sources/${id}`);
  await h.db
    .update(schema.skillSources)
    .set({ deletedAt: new Date(Date.now() - 60_000) })
    .where(eq(schema.skillSources.id, id));
  const late = await call("POST", `/api/library/sources/${id}/restore`);
  expect(late.statusCode).toBe(409);
  expect(late.json().error.code).toBe("undo_over");
});

test("a GitHub source: add, check finds a newer commit with its update view, update repins", async () => {
  const repo = path.join(tmp, "gh", "acme", "x.git");
  const first = { "tdd2/SKILL.md": md("tdd2") };
  const { shas } = await makeFixtureRepo(repo, {
    commits: [first, { ...first, "tdd2/SKILL.md": md("tdd2", "x: 1\n") }],
    branches: { old: 0 },
  });
  const p = await call("POST", "/api/library/sources/preview", {
    kind: "github",
    repo: "acme/x",
    branch: "old",
  });
  expect(p.statusCode).toBe(200);
  expect(p.json().commit).toBe(shas[0]);
  const added = await call("POST", "/api/library/sources", {
    kind: "github",
    previewId: p.json().previewId,
    skills: ["tdd2"],
  });
  expect(added.statusCode).toBe(201);
  const id = added.json().id as string;
  await h.db
    .update(schema.skillSources)
    .set({ branch: "main" })
    .where(eq(schema.skillSources.id, id));

  // Check all answers 202 at once; the result arrives as library_changed.
  const before = libraryChanges();
  const all = await call("POST", "/api/library/check");
  expect(all.statusCode).toBe(202);
  await h.app.skillSources.idle();
  expect(libraryChanges()).toBeGreaterThan(before);

  const view = (await call("GET", `/api/library/sources/${id}`)).json();
  expect(view).toMatchObject({ pin: shas[0], updateCommit: shas[1] });
  expect(view.update).toMatchObject({ from: shas[0], to: shas[1] });
  expect(view.update.changed.map((c: { name: string }) => c.name)).toEqual(["tdd2"]);

  const stale = await call("POST", `/api/library/sources/${id}/update`, { commit: "b".repeat(40) });
  expect(stale.statusCode).toBe(409);
  const updated = await call("POST", `/api/library/sources/${id}/update`, { commit: shas[1] });
  expect(updated.statusCode).toBe(200);
  expect(updated.json()).toMatchObject({ pin: shas[1], updateCommit: null });
});

/** A GitHub source of one skill with a newer commit on `main`; the add and any check happen here, not in the test. */
async function githubSourceWithNewer(repoName: string, skill: string) {
  const repo = path.join(tmp, "gh", "acme", `${repoName}.git`);
  const first = { [`${skill}/SKILL.md`]: md(skill) };
  const { shas } = await makeFixtureRepo(repo, {
    commits: [first, { ...first, [`${skill}/SKILL.md`]: md(skill, "x: 1\n") }],
    branches: { old: 0 },
  });
  const p = await call("POST", "/api/library/sources/preview", {
    kind: "github",
    repo: `acme/${repoName}`,
    branch: "old",
  });
  const added = await call("POST", "/api/library/sources", {
    kind: "github",
    previewId: p.json().previewId,
    skills: [skill],
  });
  const id = added.json().id as string;
  await h.db
    .update(schema.skillSources)
    .set({ branch: "main" })
    .where(eq(schema.skillSources.id, id));
  return { id, shas };
}

// Each case sets up its state, then returns the one call under test: that call must publish library_changed.
test.each([
  [
    "add",
    async () => {
      const root = folderOfSkills();
      return () =>
        call("POST", "/api/library/sources", { kind: "folder", path: root, skills: ["alpha"] });
    },
    201,
  ],
  [
    "update",
    async () => {
      const { id, shas } = await githubSourceWithNewer("upd", "gh-update");
      await call("POST", "/api/library/check");
      await h.app.skillSources.idle();
      return () => call("POST", `/api/library/sources/${id}/update`, { commit: shas[1] });
    },
    200,
  ],
  [
    "fetch",
    async () => {
      const { id } = await githubSourceWithNewer("fch", "gh-fetch");
      return () => call("POST", `/api/library/sources/${id}/fetch`);
    },
    200,
  ],
  [
    "restore",
    async () => {
      const root = folderOfSkills();
      const id = (
        await call("POST", "/api/library/sources", {
          kind: "folder",
          path: root,
          skills: ["alpha"],
        })
      ).json().id as string;
      await call("DELETE", `/api/library/sources/${id}`);
      return () => call("POST", `/api/library/sources/${id}/restore`);
    },
    200,
  ],
] as const)("%s publishes library_changed", async (_name, setup, status) => {
  const act = await setup();
  await h.app.skillSources.idle();
  const before = libraryChanges();
  const r = await act();
  await h.app.skillSources.idle();
  expect(r.statusCode).toBe(status);
  expect(libraryChanges()).toBeGreaterThan(before);
});

test("a failed background GitHub add removes the row and the frame names the repo", async () => {
  const repo = path.join(tmp, "gh", "acme", "y.git");
  await makeFixtureRepo(repo, { commits: [{ "s/SKILL.md": md("s") }] });
  const p = await call("POST", "/api/library/sources/preview", { kind: "github", repo: "acme/y" });
  const previewId = p.json().previewId as string;
  // A swept preview makes the add re-fetch in the background; the repo is gone by then.
  await rm(path.join(h.factoryHome, "state", "library", "preview", previewId), {
    recursive: true,
    force: true,
  });
  await rm(repo, { recursive: true, force: true });
  const added = await call("POST", "/api/library/sources", {
    kind: "github",
    previewId,
    skills: ["s"],
  });
  expect(added.statusCode).toBe(202);
  await h.app.skillSources.idle();
  expect(frames).toContainEqual({ type: "library_changed", addFailed: "acme/y" });
  expect(await h.db.select().from(schema.skillSources)).toEqual([]);
});

// Plugins and marketplaces (spec §9.1, §9.3) ------------------------------------------------------

const hostPluginsDir = () => path.join(h.config.hostClaudeDir, "plugins");

/** The acme marketplace served over file://, added through the routes; `shas` are its two commits. */
async function addAcme() {
  const made = await makeAcmeMarketplace(tmp);
  const preview = await call("POST", "/api/library/marketplaces/preview", {
    kind: "github",
    repo: "acme/mk",
  });
  expect(preview.statusCode).toBe(200);
  const added = await call("POST", "/api/library/marketplaces", {
    previewId: preview.json().previewId,
  });
  expect(added.statusCode).toBe(201);
  return { ...made, shas: made.repoShas, preview: preview.json(), added: added.json() };
}

/** Makes the `test` template declare acme (pinned at `ref`) and enable `rel@acme`. */
async function templateUsingAcme(ref: string) {
  await h.seedAgent({ slug: "dev" });
  const dir = path.join(h.factoryHome, "templates", "test");
  writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify({
      extraKnownMarketplaces: { acme: { source: { source: "github", repo: "acme/mk", ref } } },
      enabledPlugins: { "rel@acme": true },
    }),
  );
  await h.app.templates.scan();
}

test("a marketplace preview lists its catalog with what a pin can hold; add registers it at that commit", async () => {
  const w = await addAcme();
  expect(w.preview).toMatchObject({ name: "acme", commit: w.shas[1], commitPinnable: true });
  const by = Object.fromEntries(
    w.preview.plugins.map((p: { name: string }) => [p.name, p]),
  ) as Record<string, { pinnable: boolean; refusedReason?: string }>;
  expect(by.rel).toMatchObject({ pinnable: true });
  expect(by.loose).toMatchObject({ pinnable: false, refusedReason: expect.any(String) });
  expect(by.bad?.refusedReason).toBe(
    "Plugin bad@acme uses a npm source, which Open Factory doesn't install.",
  );
  expect(w.added).toMatchObject({ name: "acme", commit: w.shas[1], state: "ready" });
  const rows = (await call("GET", "/api/library/marketplaces")).json().marketplaces;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ name: "acme", users: { templates: [], agents: [] } });
  expect(rows[0].plugins.map((p: { name: string }) => p.name)).toEqual([
    "rel",
    "ext",
    "loose",
    "bad",
  ]);
  expect((await call("GET", "/api/library/marketplaces/acme")).json()).toMatchObject({
    name: "acme",
    update: null,
  });
  // The same name again is refused.
  const again = await call("POST", "/api/library/marketplaces/preview", {
    kind: "github",
    repo: "acme/mk",
  });
  expect(again.statusCode).toBe(409);
});

test("marketplace input errors are field errors", async () => {
  const bad = await call("POST", "/api/library/marketplaces/preview", {
    kind: "git",
    url: "http://example.com/x.git",
  });
  expect(bad.statusCode).toBe(400);
  expect(bad.json().error.fields.url).toEqual(expect.any(String));
  const repo = await call("POST", "/api/library/marketplaces/preview", {
    kind: "github",
    repo: "not a repo",
  });
  expect(repo.json().error.fields.repo).toEqual(expect.any(String));
  const gone = await call("POST", "/api/library/marketplaces", { previewId: ID });
  expect(gone.statusCode).toBe(400);
  expect(gone.json().error.fields.previewId).toEqual(expect.any(String));
});

test("GET /api/library/plugins groups by marketplace with pinnable, the refusal, the summary and the users with their pins", async () => {
  const w = await addAcme();
  await templateUsingAcme(w.shas[1] as string);
  const r = await call("GET", "/api/library/plugins");
  expect(r.statusCode).toBe(200);
  const { marketplaces, host } = r.json();
  expect(host).toEqual([]);
  expect(marketplaces).toHaveLength(1);
  expect(marketplaces[0]).toMatchObject({ name: "acme", commit: w.shas[1], state: "ready" });
  const by = Object.fromEntries(
    marketplaces[0].plugins.map((p: { name: string }) => [p.name, p]),
  ) as Record<string, Record<string, unknown>>;
  expect(by.rel).toMatchObject({
    key: "rel@acme",
    version: "1.1.0",
    pinnable: true,
    state: "ok",
    contentsSummary: { hooks: 2, needs: 2 },
    usedBy: {
      templates: [{ name: "test", pin: `commit:${w.shas[1]}`, agents: 1 }],
      overlays: [],
    },
  });
  expect(by.ext).toMatchObject({ canRead: true, contentsSummary: null });
  expect(by.loose).toMatchObject({
    pinnable: false,
    state: "cant_pin",
    refusedReason: "Can't be pinned: it follows its own source.",
  });
  expect(by.bad).toMatchObject({ pinnable: false, state: "refused" });
  const row = (await call("GET", "/api/library/marketplaces")).json().marketplaces[0];
  expect(row.users).toEqual({ templates: ["test"], agents: [] });
  expect(row.usedBy).toEqual({ templates: 1, agents: 0 });
});

test("a plugin's detail reads at the Library's commit, or at a commit Skills has read", async () => {
  const w = await addAcme();
  const now = (await call("GET", "/api/library/plugins/rel@acme")).json();
  expect(now).toMatchObject({ from: "library", commit: w.shas[1], version: "1.1.0" });
  expect(now.contents.hooks.map((x: { command: string }) => x.command)).toHaveLength(2);

  const unread = await call("GET", `/api/library/plugins/rel@acme?commit=${w.shas[0]}`);
  expect(unread.statusCode).toBe(404);
  expect(unread.json().error.message).toBe(`Skills hasn't read acme at ${w.shas[0]?.slice(0, 7)}.`);

  const fetched = await call("POST", "/api/library/marketplaces/acme/fetch", { ref: w.shas[0] });
  expect(fetched.statusCode).toBe(200);
  expect(fetched.json()).toEqual({ sha: w.shas[0] });
  const old = (await call("GET", `/api/library/plugins/rel@acme?commit=${w.shas[0]}`)).json();
  expect(old).toMatchObject({ commit: w.shas[0], version: "1.0.0" });
  expect(old.contents.hooks).toHaveLength(1);
});

test("the plugin file route serves a file the hooks reference and refuses any other path", async () => {
  await addAcme();
  const file = (p: string) =>
    call("GET", `/api/library/plugins/rel@acme/file?path=${encodeURIComponent(p)}`);
  expect((await file("a.js")).json()).toEqual({ path: "a.js", text: "console.log('a')\n" });
  for (const p of [".claude-plugin/plugin.json", "../outside.txt", "/etc/passwd"]) {
    const r = await file(p);
    expect({ p, status: r.statusCode }).toEqual({ p, status: 400 });
    expect(r.json().error.fields.path).toEqual(expect.any(String));
  }
});

test("POST …/diff returns what moving the plugin between two commits changes", async () => {
  const w = await addAcme();
  await call("POST", "/api/library/marketplaces/acme/fetch", { ref: w.shas[0] });
  const r = await call("POST", "/api/library/plugins/rel@acme/diff", {
    from: w.shas[0],
    to: w.shas[1],
  });
  expect(r.statusCode).toBe(200);
  expect(r.json()).toMatchObject({
    key: "rel@acme",
    from: { commit: w.shas[0], present: true, version: "1.0.0" },
    to: { commit: w.shas[1], present: true, version: "1.1.0" },
    diff: { runsCode: true, needs: { added: ["python3"], removed: [] } },
  });
  expect(r.json().diff.hooks.added.map((x: { command: string }) => x.command)).toEqual([
    "python3 b.py",
  ]);
  const bad = await call("POST", "/api/library/plugins/rel@acme/diff", {
    from: "not a commit",
    to: w.shas[1],
  });
  expect(bad.statusCode).toBe(400);
});

test("POST …/read fetches an external source so its contents show, and publishes", async () => {
  await addAcme();
  const before = (await call("GET", "/api/library/plugins/ext@acme")).json();
  expect(before).toMatchObject({
    contents: null,
    contentsNote: "Contents not read yet",
    canRead: true,
  });
  const frames0 = libraryChanges();
  const r = await call("POST", "/api/library/plugins/ext@acme/read", {});
  expect(r.statusCode).toBe(200);
  expect(r.json()).toMatchObject({ canRead: false, contentsNote: null });
  expect(r.json().contents.needs).toEqual(["uvx"]);
  expect(libraryChanges()).toBeGreaterThan(frames0);
  // A relative plugin has no source to read.
  expect((await call("POST", "/api/library/plugins/rel@acme/read", {})).statusCode).toBe(409);
});

test("check finds a newer commit, its update view lists the changed plugins, and update moves the Library's commit", async () => {
  const w = await addAcme();
  const repo = path.join(tmp, "gh", "acme", "mk.git");
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=T",
        "-c",
        "user.email=t@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      {
        cwd: repo,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", HOME: repo, GIT_CONFIG_GLOBAL: "/dev/null" },
      },
    ).trim();
  writeFileSync(path.join(repo, "plugins", "rel", "a.js"), "console.log('a2')\n");
  git("add", "-A");
  git("commit", "-q", "-m", "third");
  const third = git("rev-parse", "HEAD");

  const before = libraryChanges();
  const checked = await call("POST", "/api/library/marketplaces/acme/check");
  expect(checked.statusCode).toBe(200);
  expect(checked.json()).toMatchObject({ commit: w.shas[1], updateCommit: third });
  expect(libraryChanges()).toBeGreaterThan(before);

  const view = (await call("GET", "/api/library/marketplaces/acme")).json();
  expect(view.update).toMatchObject({ from: w.shas[1], to: third });
  expect(view.update.changed).toEqual([{ name: "rel", what: ["tree"], runsCodeChanged: true }]);

  const stale = await call("POST", "/api/library/marketplaces/acme/update", {
    commit: "b".repeat(40),
  });
  expect(stale.statusCode).toBe(409);
  const updated = await call("POST", "/api/library/marketplaces/acme/update", { commit: third });
  expect(updated.statusCode).toBe(200);
  expect(updated.json()).toMatchObject({ commit: third, updateCommit: null });
  // The old commit's checkout is still there for the templates pinned to it.
  expect((await call("GET", `/api/library/plugins/rel@acme?commit=${w.shas[1]}`)).statusCode).toBe(
    200,
  );
});

test("POST /api/library/check also checks the marketplaces, and answers 202 at once", async () => {
  await addAcme();
  const before = libraryChanges();
  expect((await call("POST", "/api/library/check")).statusCode).toBe(202);
  await h.app.marketplaces.idle();
  expect(libraryChanges()).toBeGreaterThan(before);
  expect((await call("GET", "/api/library/marketplaces/acme")).json().checkedAt).toEqual(
    expect.any(String),
  );
});

test("removal is refused while a template uses the marketplace; unused, it answers undoUntil and Undo restores it", async () => {
  const w = await addAcme();
  await templateUsingAcme(w.shas[1] as string);
  const refused = await call("DELETE", "/api/library/marketplaces/acme");
  expect(refused.statusCode).toBe(409);
  expect(refused.json().error).toMatchObject({
    code: "in_use",
    message: expect.stringContaining("template test"),
    templates: ["test"],
  });

  rmSync(path.join(h.factoryHome, "templates", "test", "settings.json"));
  await h.app.templates.scan();
  const before = libraryChanges();
  const removed = await call("DELETE", "/api/library/marketplaces/acme");
  expect(removed.statusCode).toBe(200);
  expect(Date.parse(removed.json().undoUntil)).toBeGreaterThan(Date.now());
  expect(libraryChanges()).toBeGreaterThan(before);
  expect((await call("GET", "/api/library/marketplaces/acme")).statusCode).toBe(404);
  expect((await call("GET", "/api/library/marketplaces")).json().marketplaces).toEqual([]);

  const restored = await call("POST", "/api/library/marketplaces/acme/restore");
  expect(restored.statusCode).toBe(200);
  expect(restored.json().name).toBe("acme");

  await call("DELETE", "/api/library/marketplaces/acme");
  await h.db
    .update(schema.marketplaces)
    .set({ deletedAt: new Date(Date.now() - 60_000) })
    .where(eq(schema.marketplaces.name, "acme"));
  const late = await call("POST", "/api/library/marketplaces/acme/restore");
  expect(late.statusCode).toBe(409);
  expect(late.json().error.code).toBe("undo_over");
});

test("an add whose preview was swept re-fetches: 202 with an adding row, then ready through library_changed", async () => {
  await makeAcmeMarketplace(tmp);
  const p = await call("POST", "/api/library/marketplaces/preview", {
    kind: "github",
    repo: "acme/mk",
  });
  const previewId = p.json().previewId as string;
  await rm(path.join(h.factoryHome, "state", "library", "preview", previewId), {
    recursive: true,
    force: true,
  });
  const added = await call("POST", "/api/library/marketplaces", { previewId });
  expect(added.statusCode).toBe(202);
  expect(added.json()).toMatchObject({ name: "acme", state: "adding" });
  await h.app.marketplaces.idle();
  expect((await call("GET", "/api/library/marketplaces/acme")).json().state).toBe("ready");
  expect(frames.filter((f) => f.type === "library_changed").length).toBeGreaterThan(1);
});

test("a failed background marketplace add removes the row and the frame names it", async () => {
  await makeAcmeMarketplace(tmp);
  const p = await call("POST", "/api/library/marketplaces/preview", {
    kind: "github",
    repo: "acme/mk",
  });
  const previewId = p.json().previewId as string;
  await rm(path.join(h.factoryHome, "state", "library", "preview", previewId), {
    recursive: true,
    force: true,
  });
  await rm(path.join(tmp, "gh", "acme", "mk.git"), { recursive: true, force: true });
  const added = await call("POST", "/api/library/marketplaces", { previewId });
  expect(added.statusCode).toBe(202);
  await h.app.marketplaces.idle();
  expect(frames).toContainEqual({ type: "library_changed", addFailed: "acme" });
  expect(await h.db.select().from(schema.marketplaces)).toEqual([]);
});

test("boot removes a marketplace row still adding, and keeps the checkouts the Library and a declaration hold", async () => {
  const w = await addAcme();
  await h.db.insert(schema.marketplaces).values({
    name: "half",
    source: { source: "github", repo: "acme/half" },
    commit: "c".repeat(40),
    tags: {},
    state: "adding",
    startedAt: new Date(),
    addedBy: "@or",
    addedAt: new Date(),
  });
  // A third commit is read but nothing holds it; a template pins the first, and the Library is at the second.
  const repo = path.join(tmp, "gh", "acme", "mk.git");
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=T",
        "-c",
        "user.email=t@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      {
        cwd: repo,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", HOME: repo, GIT_CONFIG_GLOBAL: "/dev/null" },
      },
    ).trim();
  git("commit", "-q", "--allow-empty", "-m", "third");
  const third = git("rev-parse", "HEAD");
  await call("POST", "/api/library/marketplaces/acme/fetch", { ref: w.shas[0] });
  await call("POST", "/api/library/marketplaces/acme/fetch", { ref: third });
  await templateUsingAcme(w.shas[0] as string);
  const checkout = (sha: string | undefined) =>
    path.join(h.factoryHome, "state", "library", "marketplaces", "acme", sha as string);
  expect([w.shas[0], w.shas[1], third].map((s) => existsSync(checkout(s)))).toEqual([
    true,
    true,
    true,
  ]);

  await h.app.close();
  const next = await h.reopen();
  expect((await next.db.select().from(schema.marketplaces)).map((r) => r.name)).toEqual(["acme"]);
  expect([w.shas[0], w.shas[1], third].map((s) => existsSync(checkout(s)))).toEqual([
    true,
    true,
    false,
  ]);
});

test("host plugins: listed when their marketplace isn't registered, added through the host's record", async () => {
  await makeAcmeMarketplace(tmp);
  const dir = path.join(hostPluginsDir(), "cache", "acme", "rel", "1.0.0");
  mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    path.join(dir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "rel", version: "1.0.0" }),
  );
  writeFileSync(
    path.join(hostPluginsDir(), "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "rel@acme": [
          {
            scope: "user",
            installPath: dir,
            version: "1.0.0",
            lastUpdated: "2026-03-01T00:00:00Z",
          },
        ],
      },
    }),
  );
  writeFileSync(
    path.join(hostPluginsDir(), "known_marketplaces.json"),
    JSON.stringify({ acme: { source: { source: "github", repo: "acme/mk" }, autoUpdate: false } }),
  );
  const listed = (await call("GET", "/api/library/plugins")).json();
  expect(listed.marketplaces).toEqual([]);
  expect(listed.host).toMatchObject([
    { key: "rel@acme", marketplace: "acme", version: "1.0.0", contentsSummary: { hooks: 0 } },
  ]);
  expect((await call("GET", "/api/library/plugins/rel@acme?from=host")).json()).toMatchObject({
    from: "host",
    version: "1.0.0",
    source: { kind: "host" },
  });

  const before = libraryChanges();
  const added = await call("POST", "/api/library/host-plugins/rel@acme/add-marketplace");
  expect(added.statusCode).toBe(201);
  expect(added.json()).toMatchObject({ name: "acme", state: "ready" });
  expect(libraryChanges()).toBeGreaterThan(before);
  // Now it is registered: the host list drops it, and the Library peek says it is also on the host.
  expect((await call("GET", "/api/library/plugins")).json().host).toEqual([]);
  expect((await call("GET", "/api/library/plugins/rel@acme")).json().hostVersion).toBe("1.0.0");
  // A second add is refused: the name is taken.
  expect(
    (await call("POST", "/api/library/host-plugins/rel@acme/add-marketplace")).statusCode,
  ).toBe(409);
});

test("a host record with userinfo can't be used to add its marketplace, and the answer doesn't carry it", async () => {
  const dir = path.join(hostPluginsDir(), "cache", "acme", "rel", "1.0.0");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(hostPluginsDir(), "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "rel@acme": [{ installPath: dir, version: "1.0.0", lastUpdated: "2026-03-01T00:00:00Z" }],
      },
    }),
  );
  writeFileSync(
    path.join(hostPluginsDir(), "known_marketplaces.json"),
    JSON.stringify({
      acme: { source: { source: "git", url: "https://user:SECRET@example.com/a.git" } },
    }),
  );
  const listed = (await call("GET", "/api/library/plugins")).json();
  expect(listed.host[0].addRefusedReason).toMatch(/^The host's record for acme can't be used: /);
  const r = await call("POST", "/api/library/host-plugins/rel@acme/add-marketplace");
  expect(r.statusCode).toBe(400);
  expect(r.json().error.code).toBe("host_record_unusable");
  expect(r.body).not.toContain("SECRET");
  expect(JSON.stringify(listed)).not.toContain("SECRET");
});

test("every marketplace write publishes library_changed", async () => {
  const w = await addAcme();
  const writes: Array<[string, () => Promise<{ statusCode: number }>]> = [
    ["check", () => call("POST", "/api/library/marketplaces/acme/check")],
    ["fetch", () => call("POST", "/api/library/marketplaces/acme/fetch", { ref: w.shas[0] })],
    // Fetches the external source into the cache the peeks read.
    [
      "diff",
      () => call("POST", "/api/library/plugins/ext@acme/diff", { from: w.shas[0], to: w.shas[1] }),
    ],
    ["remove", () => call("DELETE", "/api/library/marketplaces/acme")],
    ["restore", () => call("POST", "/api/library/marketplaces/acme/restore")],
  ];
  for (const [name, act] of writes) {
    const before = libraryChanges();
    const r = await act();
    await h.app.marketplaces.idle();
    expect({ name, status: r.statusCode }).toEqual({ name, status: 200 });
    expect({ name, published: libraryChanges() > before }).toEqual({ name, published: true });
  }
});
