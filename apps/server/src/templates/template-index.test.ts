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
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { loadConfig } from "../config.ts";
import { ApiError } from "../errors.ts";
import { createTestDb } from "../test/helpers.ts";
import { fileHash, TemplateIndex } from "./template-index.ts";

let t: Awaited<ReturnType<typeof createTestDb>>;
let idx: TemplateIndex;
let home: string;
beforeAll(async () => {
  t = await createTestDb();
  home = mkdtempSync(path.join(tmpdir(), "of-"));
  const config = loadConfig({
    DATABASE_URL: t.url,
    FACTORY_SECRET_KEY: "k".repeat(40),
    FACTORY_HOME: home,
    FACTORY_HOST_SKILLS_DIR: mkdtempSync(path.join(tmpdir(), "hs-")),
  });
  idx = new TemplateIndex({ db: t.db, config });
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
  );
  expect(res.issues.some((i) => i.severity === "error")).toBe(true);
  await expect(idx.writeFile("w1", "template.yaml", "x", yaml?.hash ?? null)).rejects.toMatchObject(
    { code: "changed_on_disk", extra: { currentHash: res.hash } },
  );
  await idx.writeFile("w1", "mcp.json", '{"mcpServers":{}}', null);
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
    await expect(idx.writeFile(n, "AGENTS.md", "x", null)).rejects.toMatchObject({ status: 404 });
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
