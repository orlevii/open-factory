import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { schema } from "@open-factory/db";
import { createFakeClaude } from "@open-factory/harness/testing";
import { type Actor, LOCAL_RUNTIME_REFUSAL } from "@open-factory/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { OrgRefusedError } from "../agents/errors.ts";
import { makeTestApp } from "../test/helpers.ts";
import { seedTestUser, testRef } from "../test/principals.ts";
import type { TemplateIndex } from "./template-index.ts";

let t: Awaited<ReturnType<typeof makeTestApp>>;
let idx: TemplateIndex;
let home: string;
const human: Actor = { kind: "human", ref: "k7x2m9qd", handle: "or" };
let hr: Actor;

const dirOf = (n: string) => path.join(home, "templates", n);
const fileOf = (n: string, f: string) => path.join(dirOf(n), f);
const read = (n: string, f: string) => readFileSync(fileOf(n, f));
const b = (name: string) => ({ name, displayName: `Copy ${name}`, description: "A copy" });

const SRC_YAML = `# keep this comment
name: dev
display_name: Dev
description: Original
runtime: docker
effort: high # trailing note
`;
function source(name: string, files: Record<string, string> = {}) {
  mkdirSync(dirOf(name), { recursive: true });
  writeFileSync(
    fileOf(name, "template.yaml"),
    files["template.yaml"] ?? SRC_YAML.replace("name: dev", `name: ${name}`),
  );
  writeFileSync(fileOf(name, "AGENTS.md"), "# persona\n");
  for (const [f, c] of Object.entries(files))
    if (f !== "template.yaml") {
      mkdirSync(path.dirname(fileOf(name, f)), { recursive: true });
      writeFileSync(fileOf(name, f), c);
    }
}
const agentOn = async (slug: string, template: string) => {
  await t.app.agents.create(
    { template, slug, displayName: slug, description: "", reportsTo: "or", credential: "work" },
    human,
  );
};

beforeAll(async () => {
  t = await makeTestApp({
    env: { FACTORY_CLAUDE_BIN: createFakeClaude({ scenario: "reply" }).bin },
  });
  home = t.factoryHome;
  idx = t.app.templates;
  await seedTestUser(t.db, "or");
  const credId = randomUUID();
  await t.db.insert(schema.credentials).values({
    id: credId,
    name: "work",
    kind: "oauth_token",
    valueEnc: t.app.vault.seal("tok", `credentials:${credId}`),
  });
  source("hrtpl");
  await idx.scan();
  await agentOn("hr-bot", "hrtpl");
  const [row] = await t.db.select().from(schema.agents).where(eq(schema.agents.slug, "hr-bot"));
  hr = { kind: "agent", id: row?.id ?? "", ref: testRef(row?.id ?? ""), slug: "hr-bot" };
});
afterAll(() => t.close());

test("a copy rewrites name, display_name and description and keeps comments", async () => {
  source("src1", { "AGENTS.md": "# persona\n" });
  await idx.scan();
  const { issues } = await idx.copyFrom("src1", b("copy1"), human);
  expect(issues.filter((i) => i.severity === "error")).toEqual([]);
  const text = read("copy1", "template.yaml").toString("utf8");
  expect(text).toContain("# keep this comment");
  expect(text).toContain("# trailing note");
  expect(text).toMatch(/^name: copy1$/m);
  expect(text).toMatch(/^display_name: Copy copy1$/m);
  expect(text).toMatch(/^description: A copy$/m);
  const [row] = await t.db
    .select()
    .from(schema.templates)
    .where(eq(schema.templates.name, "copy1"));
  expect(row?.valid).toBe(true);
});

test("settings.json, mcp.json and AGENTS.md are copied byte for byte; files/ and avatar.svg are not", async () => {
  source("src2", {
    "settings.json": '{ "hooks":   {"Stop": []} }\n',
    "mcp.json": '{"mcpServers":{}}',
    "AGENTS.md": "# persona\r\n\ttabs\n",
    "files/notes.txt": "x",
    "avatar.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
    "skills/a/SKILL.md": "---\nname: a\ndescription: d\n---\nbody\n",
    "skills/a/sub/extra.txt": "deep",
  });
  await idx.scan();
  await idx.copyFrom("src2", b("copy2"), human);
  for (const f of ["settings.json", "mcp.json", "AGENTS.md"])
    expect(read("copy2", f).equals(read("src2", f))).toBe(true);
  expect(read("copy2", "skills/a/SKILL.md").equals(read("src2", "skills/a/SKILL.md"))).toBe(true);
  expect(read("copy2", "skills/a/sub/extra.txt").toString()).toBe("deep");
  expect(existsSync(fileOf("copy2", "files"))).toBe(false);
  expect(existsSync(fileOf("copy2", "avatar.svg"))).toBe(false);
});

test.each([
  ["a symlinked skill entry", "entry", "skills/b must be a folder, not a link."],
  ["a link inside a skill", "inner", "skills/a/link.md must be a file, not a link."],
  ["a symlinked skills/", "root", "skills/ must be a folder, not a link."],
])("%s refuses the whole copy and leaves no folder behind", async (_n, kind, message) => {
  const name = `lnk-${kind}`;
  source(name);
  const outside = path.join(home, "outside");
  mkdirSync(path.join(outside, "x"), { recursive: true });
  writeFileSync(path.join(outside, "f.md"), "secret");
  if (kind === "root") symlinkSync(outside, fileOf(name, "skills"));
  else {
    mkdirSync(fileOf(name, "skills/a"), { recursive: true });
    writeFileSync(fileOf(name, "skills/a/SKILL.md"), "---\nname: a\ndescription: d\n---\n");
    if (kind === "entry") symlinkSync(path.join(outside, "x"), fileOf(name, "skills/b"));
    else symlinkSync(path.join(outside, "f.md"), fileOf(name, "skills/a/link.md"));
  }
  await idx.scan();
  const to = `to-${kind}`;
  await expect(idx.copyFrom(name, b(to), human)).rejects.toThrow(message);
  expect(existsSync(dirOf(to))).toBe(false);
  expect(readdirSync(path.join(home, "templates"))).not.toContain(to);
  expect(await t.db.select().from(schema.templates).where(eq(schema.templates.name, to))).toEqual(
    [],
  );
});

test("an existing target name is a 409 template_exists and the target is untouched", async () => {
  source("src3");
  source("taken", { "AGENTS.md": "mine\n" });
  await idx.scan();
  await expect(idx.copyFrom("src3", b("taken"), human)).rejects.toMatchObject({
    status: 409,
    code: "template_exists",
  });
  expect(read("taken", "AGENTS.md").toString()).toBe("mine\n");
});

test("copying onto the source's own name is refused at once", async () => {
  source("same");
  await idx.scan();
  await expect(idx.copyFrom("same", b("same"), human)).rejects.toMatchObject({
    status: 409,
    code: "template_exists",
  });
});

test("two crossed copies both return instead of deadlocking", async () => {
  source("ca");
  source("cb");
  await idx.scan();
  const results = await Promise.allSettled([
    idx.copyFrom("ca", b("cb"), human),
    idx.copyFrom("cb", b("ca"), human),
  ]);
  expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
});

test("a source with errors is refused", async () => {
  source("broken", { "settings.json": "{ nope" });
  await idx.scan();
  await expect(idx.copyFrom("broken", b("from-broken"), human)).rejects.toThrow(
    "Template broken has errors; fix it first.",
  );
  expect(existsSync(dirOf("from-broken"))).toBe(false);
});

test("an unknown source is a 404", async () => {
  await expect(idx.copyFrom("ghost", b("from-ghost"), human)).rejects.toMatchObject({
    status: 404,
  });
});

test("an agent can't copy a local source or a docker source with a local agent", async () => {
  source("localsrc", {
    "template.yaml": "name: localsrc\ndisplay_name: L\nruntime: local\n",
  });
  source("haslocal");
  await idx.scan();
  await agentOn("loc-agent", "haslocal");
  await t.db
    .update(schema.agents)
    .set({ runtime: "local" })
    .where(eq(schema.agents.slug, "loc-agent"));
  for (const from of ["localsrc", "haslocal"]) {
    await expect(idx.copyFrom(from, b(`c-${from}`), hr)).rejects.toThrow(
      new OrgRefusedError(LOCAL_RUNTIME_REFUSAL),
    );
    expect(existsSync(dirOf(`c-${from}`))).toBe(false);
  }
});

test("an agent copies a source holding hooks and gets no errors", async () => {
  source("hooky", {
    "settings.json": JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }] },
    }),
  });
  await idx.scan();
  const { issues } = await idx.copyFrom("hooky", b("hooky-copy"), hr);
  expect(issues.filter((i) => i.severity === "error")).toEqual([]);
  expect(read("hooky-copy", "settings.json").equals(read("hooky", "settings.json"))).toBe(true);
});
