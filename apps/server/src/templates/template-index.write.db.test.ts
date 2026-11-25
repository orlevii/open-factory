import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { schema } from "@open-factory/db";
import { createFakeClaude } from "@open-factory/harness/testing";
import { type Actor, LOCAL_RUNTIME_REFUSAL } from "@open-factory/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { OrgRefusedError } from "../agents/errors.ts";
import { PolicyInputs } from "../agents/policy-inputs.ts";
import { seedTestUser } from "../test/handles.ts";
import { makeTestApp } from "../test/helpers.ts";
import { fileHash, type TemplateIndex } from "./template-index.ts";

let t: Awaited<ReturnType<typeof makeTestApp>>;
let idx: TemplateIndex;
let home: string;
const human: Actor = { kind: "human", handle: "or" };
let hr: Actor;

const dirOf = (n: string) => path.join(home, "templates", n);
const fileOf = (n: string, f: string) => path.join(dirOf(n), f);
const yamlOf = (n: string, extra = "") => `name: ${n}\ndisplay_name: ${n}\n${extra}`;
const hashOf = (n: string, f: string) => {
  const p = fileOf(n, f);
  return existsSync(p) ? fileHash(readFileSync(p)) : null;
};
function writeTemplate(name: string, files: Record<string, string> = {}) {
  mkdirSync(dirOf(name), { recursive: true });
  writeFileSync(fileOf(name, "template.yaml"), files["template.yaml"] ?? yamlOf(name));
  writeFileSync(fileOf(name, "AGENTS.md"), `# ${name}\n`);
  for (const [f, c] of Object.entries(files))
    if (f !== "template.yaml") writeFileSync(fileOf(name, f), c);
}
const events = (agentId: string) =>
  t.sql<{ payload: { by: string; changes: string[] } }[]>`
    select payload from session_events where agent_id = ${agentId} and type = 'config_changed'`;
const idOf = async (slug: string) => {
  const [r] = await t.db.select().from(schema.agents).where(eq(schema.agents.slug, slug));
  if (!r) throw new Error(`no agent ${slug}`);
  return r.id;
};
const agentOn = async (slug: string, template: string, reportsTo = "or") => {
  await t.app.agents.create(
    { template, slug, displayName: slug, description: "", reportsTo, credential: "work" },
    human,
  );
};

beforeAll(async () => {
  t = await makeTestApp({
    env: { FACTORY_CLAUDE_BIN: createFakeClaude({ scenario: "reply" }).bin },
  });
  home = t.factoryHome;
  idx = t.app.templates;
  await seedTestUser(t.db);
  mkdtempSync(path.join(tmpdir(), "repo-"));
  const credId = randomUUID();
  await t.db.insert(schema.credentials).values({
    id: credId,
    name: "work",
    kind: "oauth_token",
    valueEnc: t.app.vault.seal("tok", `credentials:${credId}`),
  });
  writeTemplate("other");
  writeTemplate("hrtpl");
  await idx.scan();
  await agentOn("hr-bot", "hrtpl");
  hr = { kind: "agent", id: await idOf("hr-bot"), slug: "hr-bot" };
});
afterAll(() => t.close());
afterEach(() => vi.restoreAllMocks());

test("an agent write with a policy issue leaves the file byte-identical", async () => {
  writeTemplate("pol");
  await idx.scan();
  const before = readFileSync(fileOf("pol", "template.yaml"), "utf8");
  await expect(
    idx.writeFile(
      "pol",
      "template.yaml",
      yamlOf("pol", "permission_mode: bypass\n"),
      hashOf("pol", "template.yaml"),
      hr,
    ),
  ).rejects.toMatchObject({
    code: "invalid_config",
    extra: {
      issues: [
        expect.objectContaining({ message: "permission_mode can only be changed by a human." }),
      ],
    },
  });
  expect(readFileSync(fileOf("pol", "template.yaml"), "utf8")).toBe(before);
});

test("a human write keeps today's behaviour: saved with errors", async () => {
  writeTemplate("hum");
  await idx.scan();
  const res = await idx.writeFile(
    "hum",
    "template.yaml",
    yamlOf("hum", "modle: x\n"),
    hashOf("hum", "template.yaml"),
    human,
  );
  expect(res.issues.some((i) => i.severity === "error")).toBe(true);
  expect(readFileSync(fileOf("hum", "template.yaml"), "utf8")).toContain("modle");
});

test("two concurrent writes with the same baseHash give one success and one 409", async () => {
  writeTemplate("race");
  await idx.scan();
  const base = hashOf("race", "AGENTS.md");
  const results = await Promise.allSettled([
    idx.writeFile("race", "AGENTS.md", "# one\n", base, human),
    idx.writeFile("race", "AGENTS.md", "# two\n", base, hr),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const failed = results.find((r) => r.status === "rejected");
  expect((failed as PromiseRejectedResult).reason).toMatchObject({
    status: 409,
    code: "changed_on_disk",
  });
});

test("a broken mcp.json: an agent edit of settings.json passes, and the fix of mcp.json itself succeeds", async () => {
  writeTemplate("brk", { "mcp.json": "{not json" });
  await idx.scan();
  const ok = await idx.writeFile(
    "brk",
    "settings.json",
    JSON.stringify({ permissions: { deny: ["Bash(rm:*)"] } }),
    null,
    hr,
  );
  expect(ok.issues.some((i) => i.file === "mcp.json" && i.severity === "error")).toBe(true);
  await idx.writeFile("brk", "mcp.json", '{"mcpServers":{}}', hashOf("brk", "mcp.json"), hr);
  expect(readFileSync(fileOf("brk", "mcp.json"), "utf8")).toBe('{"mcpServers":{}}');
});

test("an unparseable current template.yaml refuses every agent write", async () => {
  writeTemplate("badyaml", { "template.yaml": "name: [\n" });
  await idx.scan();
  const expected = new OrgRefusedError("template.yaml has errors; ask a human to fix it.");
  await expect(
    idx.writeFile("badyaml", "AGENTS.md", "# x\n", hashOf("badyaml", "AGENTS.md"), hr),
  ).rejects.toThrow(expected);
  await expect(
    idx.writeFile(
      "badyaml",
      "template.yaml",
      yamlOf("badyaml"),
      hashOf("badyaml", "template.yaml"),
      hr,
    ),
  ).rejects.toThrow(expected);
});

test("an agent write to a linked folder or target file is refused", async () => {
  writeTemplate("realdir");
  renameSync(dirOf("realdir"), path.join(home, "realdir-target"));
  symlinkSync(path.join(home, "realdir-target"), dirOf("linkdir"));
  await expect(
    idx.writeFile("linkdir", "AGENTS.md", "# x\n", hashOf("linkdir", "AGENTS.md"), hr),
  ).rejects.toThrow(new OrgRefusedError("linkdir is a link; ask a human."));
  writeTemplate("linkfile");
  writeFileSync(path.join(home, "elsewhere.md"), "# e\n");
  const target = fileOf("linkfile", "AGENTS.md");
  renameSync(target, `${target}.orig`);
  symlinkSync(path.join(home, "elsewhere.md"), target);
  await expect(
    idx.writeFile("linkfile", "AGENTS.md", "# x\n", hashOf("linkfile", "AGENTS.md"), hr),
  ).rejects.toThrow(new OrgRefusedError("AGENTS.md is a link; ask a human."));
  expect(readFileSync(path.join(home, "elsewhere.md"), "utf8")).toBe("# e\n");
});

test("an agent cannot write a template whose own runtime is local, even with no agents; a human can", async () => {
  writeTemplate("ownlocal", {
    "template.yaml": yamlOf("ownlocal", "runtime: local\n"),
    "settings.json": "{}",
  });
  await idx.scan();
  const before = readFileSync(fileOf("ownlocal", "AGENTS.md"));
  for (const [file, content] of [
    ["AGENTS.md", "# x\n"],
    ["settings.json", '{"effortLevel":"high"}'],
  ] as const) {
    await expect(
      idx.writeFile("ownlocal", file, content, hashOf("ownlocal", file), hr),
    ).rejects.toThrow(new OrgRefusedError(LOCAL_RUNTIME_REFUSAL));
  }
  expect(readFileSync(fileOf("ownlocal", "AGENTS.md")).equals(before)).toBe(true);
  expect(readFileSync(fileOf("ownlocal", "settings.json"), "utf8")).toBe("{}");
  await idx.writeFile("ownlocal", "AGENTS.md", "# x\n", hashOf("ownlocal", "AGENTS.md"), human);
  expect(readFileSync(fileOf("ownlocal", "AGENTS.md"), "utf8")).toBe("# x\n");
});

test("an agent write to a template with an archived local agent is refused (R9)", async () => {
  writeTemplate("haslocal");
  await idx.scan();
  await agentOn("loc-agent", "haslocal");
  await t.db
    .update(schema.agents)
    .set({ runtime: "local", archivedAt: new Date() })
    .where(eq(schema.agents.slug, "loc-agent"));
  await expect(
    idx.writeFile("haslocal", "AGENTS.md", "# x\n", hashOf("haslocal", "AGENTS.md"), hr),
  ).rejects.toThrow(new OrgRefusedError(LOCAL_RUNTIME_REFUSAL));
  await idx.writeFile("haslocal", "AGENTS.md", "# x\n", hashOf("haslocal", "AGENTS.md"), human);
});

test("an agent can drop a can_spawn entry that names a missing template, but not add a local one", async () => {
  writeTemplate("fix", { "template.yaml": yamlOf("fix", "can_spawn: [ghost]\n") });
  writeTemplate("loc", { "template.yaml": yamlOf("loc", "runtime: local\n") });
  await idx.scan();
  await idx.writeFile("fix", "template.yaml", yamlOf("fix"), hashOf("fix", "template.yaml"), hr);
  expect(readFileSync(fileOf("fix", "template.yaml"), "utf8")).toBe(yamlOf("fix"));
  await expect(
    idx.writeFile(
      "fix",
      "template.yaml",
      yamlOf("fix", "can_spawn: [loc]\n"),
      hashOf("fix", "template.yaml"),
      hr,
    ),
  ).rejects.toThrow(new OrgRefusedError(LOCAL_RUNTIME_REFUSAL));
});

test("the lock carries the author: a loadValid started mid-write waits, and the one dispatch names the writer", async () => {
  writeTemplate("dev");
  await idx.scan();
  await agentOn("dev-agent", "dev");
  const devId = await idOf("dev-agent");
  let entered: () => void = () => {};
  const inside = new Promise<void>((r) => {
    entered = r;
  });
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const real = PolicyInputs.prototype.templateRuntimes;
  vi.spyOn(PolicyInputs.prototype, "templateRuntimes").mockImplementation(async function (
    this: PolicyInputs,
    names: string[],
  ) {
    entered();
    await gate;
    return real.call(this, names);
  });
  const write = idx.writeFile(
    "dev",
    "template.yaml",
    yamlOf("dev", "can_spawn: [other]\n"),
    hashOf("dev", "template.yaml"),
    hr,
  );
  await inside;
  let loaded = false;
  const load = idx.loadValid("dev").then((v) => {
    loaded = true;
    return v;
  });
  // Another template's scan doesn't wait for this one's writer.
  await idx.scanOne("other");
  await new Promise((r) => setTimeout(r, 100));
  expect(loaded).toBe(false);
  release();
  await write;
  expect((await load).doc.template.can_spawn).toEqual(["other"]);
  await vi.waitFor(async () =>
    expect((await events(devId)).map((e) => e.payload.by)).toEqual(["@hr-bot in template dev"]),
  );
});

test("create and remove hold the lock and both return; a readConfig started during create sees the finished template", async () => {
  const created = idx.create({ name: "fresh", displayName: "Fresh" }, human);
  const read = idx.readConfig("fresh").catch((e) => e);
  await created;
  expect(await read).toMatchObject({ doc: expect.anything() });
  await idx.remove("fresh");
  expect(existsSync(dirOf("fresh"))).toBe(false);
  const [row] = await t.db
    .select()
    .from(schema.templates)
    .where(eq(schema.templates.name, "fresh"));
  expect(row).toBeUndefined();
});
