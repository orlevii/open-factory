import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { schema } from "@open-factory/db";
import type { ConfigDoc } from "@open-factory/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { loadConfig } from "../config.ts";
import { ApiError } from "../errors.ts";
import { claimTestHandle } from "../test/handles.ts";
import { createTestDb } from "../test/helpers.ts";
import { configDocHash, fileHash, type TemplateChange, TemplateIndex } from "./template-index.ts";

let t: Awaited<ReturnType<typeof createTestDb>>;
let idx: TemplateIndex;
let home: string;
let cfg: ReturnType<typeof loadConfig>;
const hostSkills = mkdtempSync(path.join(tmpdir(), "hs-"));
for (const n of ["tdd", "release"]) mkdirSync(path.join(hostSkills, n));
const SECRET = "sk-ant-oat01-SECRETSHAPED0123456789";
const events: TemplateChange[] = [];
const eventsFor = (name: string) => events.filter((e) => e.name === name);
const yamlPath = (n: string) => path.join(home, "templates", n, "template.yaml");
const yamlWith = (n: string, extra = "") => `name: ${n}\ndisplay_name: ${n}\n${extra}`;
const settle = (name: string, n: number) =>
  vi.waitFor(() => expect(eventsFor(name).length).toBeGreaterThanOrEqual(n));
beforeAll(async () => {
  t = await createTestDb();
  home = mkdtempSync(path.join(tmpdir(), "of-"));
  cfg = loadConfig({
    DATABASE_URL: t.url,
    FACTORY_SECRET_KEY: "k".repeat(40),
    FACTORY_HOME: home,
    FACTORY_HOST_SKILLS_DIR: hostSkills,
  });
  idx = new TemplateIndex({ db: t.db, config: cfg });
  idx.onChange((e) => {
    events.push(e);
  });
});
afterAll(() => t.close());

test("create → scan → detail; on-disk edits and deletions show on the next scan", async () => {
  await idx.create({ name: "tech-lead", displayName: "Tech Lead" });
  expect(readFileSync(path.join(home, "templates/tech-lead/template.yaml"), "utf8")).toContain(
    "runtime: docker",
  );
  let rows = await idx.scan();
  expect(rows.map((r) => r.name)).toEqual(["tech-lead"]);
  writeFileSync(
    path.join(home, "templates/tech-lead/template.yaml"),
    "name: tech-lead\ndisplay_name: TL2\n",
  );
  expect((await idx.detail("tech-lead")).config?.displayName).toBe("TL2");
  mkdirSync(path.join(home, "templates/.hidden"));
  mkdirSync(path.join(home, "templates/not-a-template"));
  rows = await idx.scan();
  expect(rows.map((r) => r.name)).toEqual(["tech-lead"]);
  await expect(idx.create({ name: "tech-lead", displayName: "X" })).rejects.toMatchObject({
    code: "template_exists",
  });
});

test("writeFile: hash check, invalid content still written, optional file creation", async () => {
  await idx.create({ name: "w1", displayName: "W" });
  const d = await idx.detail("w1");
  const yaml = d.files.find((f) => f.file === "template.yaml");
  const res = await idx.writeFile(
    "w1",
    "template.yaml",
    "name: w1\ndisplay_name: W\nmodle: x\n",
    yaml?.hash ?? null,
    "@or",
  );
  expect(res.issues.some((i) => i.severity === "error")).toBe(true);
  await expect(
    idx.writeFile("w1", "template.yaml", "x", yaml?.hash ?? null, "@or"),
  ).rejects.toMatchObject({ code: "changed_on_disk", extra: { currentHash: res.hash } });
  await idx.writeFile("w1", "mcp.json", '{"mcpServers":{}}', null, "@or");
  expect(existsSync(path.join(home, "templates/w1/mcp.json"))).toBe(true);
});

test("validate substitutes content without writing", async () => {
  await idx.create({ name: "v1", displayName: "V" });
  const issues = await idx.validate(
    "v1",
    "template.yaml",
    "name: v1\ndisplay_name: V\nprojects: [nope]\n",
  );
  expect(issues.map((i) => i.message)).toContainEqual(expect.stringMatching(/nope/));
  expect(readFileSync(path.join(home, "templates/v1/template.yaml"), "utf8")).not.toContain("nope");
});

test("remove deletes a folder, and only the link for a symlinked folder; 404 for gone templates", async () => {
  await idx.create({ name: "r1", displayName: "R" });
  await idx.remove("r1");
  expect(existsSync(path.join(home, "templates/r1"))).toBe(false);
  const outside = mkdtempSync(path.join(tmpdir(), "ext-"));
  writeFileSync(path.join(outside, "template.yaml"), "name: linked\ndisplay_name: L\n");
  writeFileSync(path.join(outside, "AGENTS.md"), "# L\n");
  symlinkSync(outside, path.join(home, "templates/linked"));
  expect((await idx.scan()).map((r) => r.name)).toContain("linked");
  await idx.remove("linked");
  expect(existsSync(outside)).toBe(true);
  await expect(idx.detail("linked")).rejects.toBeInstanceOf(ApiError);
});

test("content hash covers skills/ and files/", async () => {
  await idx.create({ name: "h1", displayName: "H" });
  const before = (await idx.scanOne("h1"))?.contentHash;
  mkdirSync(path.join(home, "templates/h1/files"), { recursive: true });
  writeFileSync(path.join(home, "templates/h1/files/x.txt"), "x");
  expect((await idx.scanOne("h1"))?.contentHash).not.toBe(before);
  expect(fileHash(Buffer.from("a"))).toHaveLength(64);
});

test("create round-trips long and special-character descriptions", async () => {
  const long = "word ".repeat(30).trim();
  await idx.create({ name: "d-long", displayName: "D", description: long });
  expect((await idx.detail("d-long")).config?.description).toBe(long);
  const special = "see #1: a thing, really";
  await idx.create({ name: "d-spec", displayName: "Hash # and: colon", description: special });
  const d = await idx.detail("d-spec");
  expect(d.config?.description).toBe(special);
  expect(d.config?.displayName).toBe("Hash # and: colon");
  expect(d.issues.filter((i) => i.severity === "error")).toEqual([]);
});

test("create removes its folder when a later write fails", async () => {
  const b = {
    name: "bad-create",
    get displayName(): string {
      throw new Error("boom");
    },
  };
  await expect(idx.create(b)).rejects.toThrow("boom");
  expect(existsSync(path.join(home, "templates/bad-create"))).toBe(false);
});

test("names that fail the pattern are 404 everywhere", async () => {
  for (const n of ["../x", "A"]) {
    await expect(idx.detail(n)).rejects.toMatchObject({ code: "template_not_found" });
    await expect(idx.writeFile(n, "AGENTS.md", "x", null, "@or")).rejects.toMatchObject({
      status: 404,
    });
    await expect(idx.validate(n, "AGENTS.md", "x")).rejects.toMatchObject({ status: 404 });
    await expect(idx.remove(n)).rejects.toMatchObject({ status: 404 });
  }
});

test("scan prunes a row whose folder vanished; remove of a gone folder drops the stale row", async () => {
  await idx.create({ name: "gone1", displayName: "G" });
  await idx.create({ name: "gone2", displayName: "G" });
  await rm(path.join(home, "templates/gone1"), { recursive: true });
  expect((await idx.scan()).map((r) => r.name)).not.toContain("gone1");
  const hasRow = async (n: string) =>
    (await t.db.select().from(schema.templates).where(eq(schema.templates.name, n))).length > 0;
  expect(await hasRow("gone1")).toBe(false);
  await rm(path.join(home, "templates/gone2"), { recursive: true });
  expect(await hasRow("gone2")).toBe(true);
  await expect(idx.remove("gone2")).rejects.toMatchObject({ status: 404 });
  expect(await hasRow("gone2")).toBe(false);
});

test("a folder that fails to index is skipped without pruning the others", async () => {
  await idx.create({ name: "ok1", displayName: "O" });
  mkdirSync(path.join(home, "templates/Bad_Name"));
  writeFileSync(path.join(home, "templates/Bad_Name/template.yaml"), "name: x\n");
  expect((await idx.scan()).map((r) => r.name)).toContain("ok1");
  expect((await idx.scan()).map((r) => r.name)).not.toContain("Bad_Name");
});

test("a user image counts only as a direct child of images/: a link leaving it doesn't validate", async () => {
  const outside = mkdtempSync(path.join(tmpdir(), "of-outside-"));
  writeFileSync(path.join(outside, "Dockerfile"), "FROM scratch\n");
  mkdirSync(path.join(home, "images/real"), { recursive: true });
  writeFileSync(path.join(home, "images/real/Dockerfile"), "FROM scratch\n");
  symlinkSync(outside, path.join(home, "images/evil"));
  try {
    const ctx = await idx.context();
    expect(ctx.userImages.has("real")).toBe(true);
    expect(ctx.userImages.has("evil")).toBe(false);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("a change to skills fires onChange once, with before and after", async () => {
  await idx.create({ name: "cd1", displayName: "C" });
  await idx.scanOne("cd1");
  await settle("cd1", 1);
  expect(eventsFor("cd1")[0]?.before).toBeNull();
  writeFileSync(yamlPath("cd1"), yamlWith("cd1", "skills: [tdd]\n"));
  await idx.scanOne("cd1");
  await settle("cd1", 2);
  await idx.scanOne("cd1");
  await idx.scan();
  const e = eventsFor("cd1");
  expect(e).toHaveLength(2);
  expect(e[1]?.before?.template.skills).toBeUndefined();
  expect(e[1]?.after.template.skills).toEqual(["tdd"]);
  expect(e[1]?.by).toBe("file change");
  expect(await idx.lastValid("cd1")).toEqual(e[1]?.after);
});

test("five concurrent scanOne calls after one edit fire exactly once", async () => {
  await idx.create({ name: "cd2", displayName: "C" });
  await idx.scanOne("cd2");
  await settle("cd2", 1);
  writeFileSync(yamlPath("cd2"), yamlWith("cd2", "skills: [release]\n"));
  await Promise.all([1, 2, 3, 4, 5].map(() => idx.scanOne("cd2")));
  await settle("cd2", 2);
  await new Promise((r) => setTimeout(r, 50));
  expect(eventsFor("cd2")).toHaveLength(2);
});

test("an AGENTS.md edit moves content_hash but not last_valid_hash, and fires nothing", async () => {
  await idx.create({ name: "cd3", displayName: "C" });
  const first = await idx.scanOne("cd3");
  await settle("cd3", 1);
  writeFileSync(path.join(home, "templates/cd3/AGENTS.md"), "# Changed\n");
  const second = await idx.scanOne("cd3");
  expect(second?.contentHash).not.toBe(first?.contentHash);
  expect(second?.lastValidHash).toBe(first?.lastValidHash);
  expect(second?.lastValidHash).toBe(configDocHash(second?.lastValid as ConfigDoc));
  await new Promise((r) => setTimeout(r, 50));
  expect(eventsFor("cd3")).toHaveLength(1);
});

test("valid, invalid, valid again: no event while invalid, then before is the old doc", async () => {
  await idx.create({ name: "cd4", displayName: "C" });
  const v1 = await idx.scanOne("cd4");
  await settle("cd4", 1);
  writeFileSync(yamlPath("cd4"), yamlWith("cd4", "modle: x\n"));
  const bad = await idx.scanOne("cd4");
  expect(bad?.valid).toBe(false);
  expect(bad?.lastValidHash).toBe(v1?.lastValidHash);
  expect(await idx.lastValid("cd4")).toEqual(v1?.lastValid);
  await new Promise((r) => setTimeout(r, 50));
  expect(eventsFor("cd4")).toHaveLength(1);
  writeFileSync(yamlPath("cd4"), yamlWith("cd4", "skills: [tdd]\n"));
  const good = await idx.scanOne("cd4");
  expect(good?.valid).toBe(true);
  await settle("cd4", 2);
  expect(eventsFor("cd4")[1]?.before).toEqual(v1?.lastValid);
  expect(eventsFor("cd4")[1]?.after.template.skills).toEqual(["tdd"]);
});

test("returning to the same valid parse after an invalid one only flips valid back", async () => {
  await idx.create({ name: "cd5", displayName: "C" });
  const original = readFileSync(yamlPath("cd5"), "utf8");
  await idx.scanOne("cd5");
  await settle("cd5", 1);
  writeFileSync(yamlPath("cd5"), yamlWith("cd5", "modle: x\n"));
  expect((await idx.scanOne("cd5"))?.valid).toBe(false);
  writeFileSync(yamlPath("cd5"), original);
  expect((await idx.scanOne("cd5"))?.valid).toBe(true);
  await new Promise((r) => setTimeout(r, 50));
  expect(eventsFor("cd5")).toHaveLength(1);
});

test("a folder deleted and restored fires with before null", async () => {
  await idx.create({ name: "cd6", displayName: "C" });
  await idx.scanOne("cd6");
  await settle("cd6", 1);
  const yaml = readFileSync(yamlPath("cd6"), "utf8");
  await rm(path.join(home, "templates/cd6"), { recursive: true });
  expect(await idx.scanOne("cd6")).toBeUndefined();
  expect(await idx.lastValid("cd6")).toBeNull();
  mkdirSync(path.join(home, "templates/cd6"));
  writeFileSync(yamlPath("cd6"), yaml);
  writeFileSync(path.join(home, "templates/cd6/AGENTS.md"), "# C\n");
  await idx.scanOne("cd6");
  await settle("cd6", 2);
  expect(eventsFor("cd6")[1]?.before).toBeNull();
});

test("a write through the API reports its author; scanOne never awaits listeners", async () => {
  await idx.create({ name: "cd7", displayName: "C" });
  await idx.scanOne("cd7");
  await settle("cd7", 1);
  let release: () => void = () => {};
  let started = false;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const slow = new TemplateIndex({ db: t.db, config: cfg });
  const slowSeen: TemplateChange[] = [];
  slow.onChange(async (e) => {
    started = true;
    slowSeen.push(e);
    await gate;
  });
  await slow.scanOne("cd7");
  const hash = (await idx.detail("cd7")).files.find((f) => f.file === "template.yaml")?.hash;
  const res = await Promise.race([
    slow.writeFile(
      "cd7",
      "template.yaml",
      yamlWith("cd7", "skills: [tdd]\n"),
      hash ?? null,
      "@ana",
    ),
    new Promise((r) => setTimeout(() => r("timeout"), 5000)),
  ]);
  expect(res).not.toBe("timeout");
  await vi.waitFor(() => expect(started).toBe(true));
  expect(slowSeen.at(-1)?.by).toBe("@ana");
  release();
});

test("a failing listener is logged and does not stop the next one", async () => {
  const logged: unknown[] = [];
  const log = { error: (...a: unknown[]) => void logged.push(a) };
  const own = new TemplateIndex({ db: t.db, config: cfg, log: log as never });
  const seen: string[] = [];
  own.onChange(() => {
    throw new Error("listener boom");
  });
  own.onChange((e) => {
    seen.push(e.name);
  });
  await idx.create({ name: "cd8", displayName: "C" });
  writeFileSync(
    path.join(home, "templates/cd8/mcp.json"),
    JSON.stringify({ mcpServers: { gh: { command: "x", env: { TOKEN: SECRET } } } }),
  );
  await own.scanOne("cd8");
  await vi.waitFor(() => expect(seen).toEqual(["cd8"]));
  expect(logged).toHaveLength(1);
  // The dispatched doc carries the MCP env; the log payload is exactly the error and the template name.
  const [payload] = logged[0] as [Record<string, unknown>, string];
  expect(Object.keys(payload).sort()).toEqual(["err", "template"]);
  expect(payload.template).toBe("cd8");
  expect(JSON.stringify({ ...payload, err: undefined })).not.toContain(SECRET);
});

async function seedUser(
  slug: string,
  o: { archived?: boolean; terminated?: boolean; template: string },
) {
  await claimTestHandle(t.db, slug, "agent");
  const credentialId = `cred-${slug}`;
  await t.db.insert(schema.credentials).values({
    id: credentialId,
    name: credentialId,
    kind: "oauth_token",
    valueEnc: Buffer.from("x"),
  });
  if (o.terminated) {
    const mgrSlug = `mgr-${slug}`;
    await claimTestHandle(t.db, mgrSlug, "agent");
    const mgrCred = `cred-${mgrSlug}`;
    await t.db.insert(schema.credentials).values({
      id: mgrCred,
      name: mgrCred,
      kind: "oauth_token",
      valueEnc: Buffer.from("x"),
    });
    const [mgr] = await t.db
      .insert(schema.agents)
      .values({
        id: `id-${mgrSlug}`,
        slug: mgrSlug,
        displayName: mgrSlug,
        template: "mgr-template",
        runtime: "local",
        credentialId: mgrCred,
      })
      .returning({ id: schema.agents.id });
    await t.db.insert(schema.agents).values({
      id: `id-${slug}`,
      slug,
      displayName: slug,
      template: o.template,
      runtime: "local",
      kind: "ephemeral",
      reportsTo: mgr?.id,
      terminatedAt: new Date(),
      terminatedBy: "@factory",
    });
    return;
  }
  await t.db.insert(schema.agents).values({
    id: `id-${slug}`,
    slug,
    displayName: slug,
    template: o.template,
    runtime: "local",
    credentialId,
    ...(o.archived ? { archivedAt: new Date() } : {}),
  });
}

test("remove refuses with template_in_use while an agent, archived included, uses it", async () => {
  await idx.create({ name: "use1", displayName: "U" });
  await seedUser("ana", { template: "use1" });
  await seedUser("bo", { template: "use1", archived: true });
  await seedUser("cy", { template: "use1" });
  await expect(idx.remove("use1")).rejects.toMatchObject({
    status: 409,
    code: "template_in_use",
    message: "@ana and 2 more (1 archived) use this template. Archive and recreate them first.",
  });
  expect(existsSync(path.join(home, "templates/use1"))).toBe(true);
});

test("terminated spawned agents don't block deletion", async () => {
  await idx.create({ name: "use2", displayName: "U" });
  await seedUser("dee", { template: "use2", terminated: true });
  await idx.remove("use2");
  expect(existsSync(path.join(home, "templates/use2"))).toBe(false);
});

test("a slow older scan cannot regress last_valid after a newer scan won", async () => {
  await idx.create({ name: "cd9", displayName: "C" });
  await idx.scanOne("cd9");
  await settle("cd9", 1);
  writeFileSync(yamlPath("cd9"), yamlWith("cd9", "skills: [tdd]\n"));
  const first = idx.scanOne("cd9");
  // The second scan starts while the first is in flight and the file moves on.
  writeFileSync(yamlPath("cd9"), yamlWith("cd9", "skills: [release]\n"));
  const second = idx.scanOne("cd9");
  await Promise.all([first, second]);
  await settle("cd9", 2);
  await idx.scanOne("cd9");
  await new Promise((r) => setTimeout(r, 50));
  const e = eventsFor("cd9");
  // Whatever the interleaving, the chain of events is consistent and ends on the file's content.
  expect((await idx.lastValid("cd9"))?.template.skills).toEqual(["release"]);
  for (let i = 1; i < e.length; i++) expect(e[i]?.before).toEqual(e[i - 1]?.after);
  expect(e.at(-1)?.after.template.skills).toEqual(["release"]);
});
