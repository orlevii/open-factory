import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { schema } from "@open-factory/db";
import type { ServerMessage } from "@open-factory/shared";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test } from "vitest";
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
  expect(body.hostDir).toBe(h.hostSkillsDir);
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
