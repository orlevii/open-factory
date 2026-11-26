import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { schema } from "@open-factory/db";
import type { Actor } from "@open-factory/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { makeTestApp } from "../../test/helpers.ts";
import { seedTestUser } from "../../test/principals.ts";
import { callTool, mcpCall } from "../testing/mcp-client.ts";

const TEMPLATE_TOOLS = ["create_template", "write_template_file"];
const TOKEN = "sk-ant-oat01-tpl";

let t: Awaited<ReturnType<typeof makeTestApp>>;
let url: string;
const human: Actor = { kind: "human", ref: "k7x2m9qd", handle: "or" };
const tok: Record<string, string> = {};
const row = async (slug: string) => {
  const [r] = await t.db.select().from(schema.agents).where(eq(schema.agents.slug, slug));
  if (!r) throw new Error(`no agent ${slug}`);
  return r;
};
const dirOf = (name: string) => path.join(t.factoryHome, "templates", name);
const read = (name: string, file: string) => readFileSync(path.join(dirOf(name), file), "utf8");
const call = async (who: string, name: string, args: object) => {
  const r = await callTool(url, tok[who] as string, name, args);
  const text = r.content[0]?.text ?? "";
  return { err: r.isError === true, text, json: r.isError ? undefined : JSON.parse(text) };
};
const names = async (who: string) =>
  (
    (await mcpCall(url, tok[who] as string, "tools/list", {})).json.result.tools as {
      name: string;
    }[]
  ).map((x) => x.name);
const frames = () => vi.spyOn(t.app.bus, "publishAll");
const orgFrames = (spy: ReturnType<typeof frames>) =>
  spy.mock.calls.map(([m]) => m).filter((m) => m.type === "org_action");
const hashOf = async (who: string, name: string, file: string) =>
  (await call(who, "get_template", { name })).json.files[file].hash as string;

beforeAll(async () => {
  t = await makeTestApp();
  await seedTestUser(t.db, "or");
  url = `http://127.0.0.1:${t.app.agentListener.port}`;
  const credId = randomUUID();
  await t.db.insert(schema.credentials).values({
    id: credId,
    name: "work",
    kind: "oauth_token",
    valueEnc: t.app.vault.seal(TOKEN, `credentials:${credId}`),
  });
  // A valid source template with a skill and a files/ folder (which a copy leaves behind).
  mkdirSync(path.join(dirOf("dev"), "skills", "helper"), { recursive: true });
  mkdirSync(path.join(dirOf("dev"), "files"), { recursive: true });
  writeFileSync(
    path.join(dirOf("dev"), "template.yaml"),
    "name: dev\ndisplay_name: Developer\ndescription: The source\nruntime: docker\n",
  );
  writeFileSync(path.join(dirOf("dev"), "AGENTS.md"), "# Developer\n\nWrite code.\n");
  writeFileSync(path.join(dirOf("dev"), "settings.json"), "{}");
  writeFileSync(
    path.join(dirOf("dev"), "skills", "helper", "SKILL.md"),
    "---\nname: helper\ndescription: helps\n---\nBody\n",
  );
  writeFileSync(path.join(dirOf("dev"), "files", "note.txt"), "not copied");
  await t.app.templates.scan();
  await t.app.agents.create(
    {
      template: "dev",
      slug: "hr-bot",
      displayName: "hr-bot",
      description: "",
      reportsTo: "or",
      credential: "work",
    },
    human,
  );
  await t.app.agents.update("hr-bot", { manageOrg: true }, human);
  await t.app.agents.create(
    {
      template: "dev",
      slug: "plain",
      displayName: "plain",
      description: "",
      reportsTo: "or",
      credential: "work",
    },
    human,
  );
  for (const s of ["hr-bot", "plain"]) tok[s] = t.app.agentTokens.mint((await row(s)).id).token;
});
afterAll(() => t.close());

test("only a manage_org caller lists create_template and write_template_file", async () => {
  const plain = await names("plain");
  for (const n of TEMPLATE_TOOLS) expect(plain).not.toContain(n);
  const hr = await names("hr-bot");
  for (const n of TEMPLATE_TOOLS) expect(hr).toContain(n);
});

test("create_template without from writes the scaffold, lists it and publishes template_created", async () => {
  const spy = frames();
  try {
    const r = await call("hr-bot", "create_template", {
      name: "scaffold",
      display_name: "Scaffold",
      description: "Fresh",
    });
    expect(r.err).toBe(false);
    expect(r.json.name).toBe("scaffold");
    expect(read("scaffold", "template.yaml")).toContain("runtime: docker");
    expect(read("scaffold", "template.yaml")).toContain("display_name: Scaffold");
    expect(read("scaffold", "AGENTS.md")).toBe("# Scaffold\n");
    expect((await call("hr-bot", "list_templates", {})).json).toContainEqual(
      expect.objectContaining({ name: "scaffold", valid: true }),
    );
    expect(orgFrames(spy)).toEqual([
      { type: "org_action", action: "template_created", by: "@hr-bot", subject: "scaffold" },
    ]);
  } finally {
    spy.mockRestore();
  }
});

test("create_template with from copies the four files and skills, rewrites the identity and leaves files/ behind", async () => {
  const spy = frames();
  try {
    const r = await call("hr-bot", "create_template", {
      name: "copy-of-dev",
      display_name: "Copy",
      from: "dev",
    });
    expect(r.err).toBe(false);
    expect(r.json.name).toBe("copy-of-dev");
    const yaml = read("copy-of-dev", "template.yaml");
    expect(yaml).toContain("name: copy-of-dev");
    expect(yaml).toContain("display_name: Copy");
    expect(yaml).not.toContain("display_name: Developer");
    expect(read("copy-of-dev", "AGENTS.md")).toBe(read("dev", "AGENTS.md"));
    expect(read("copy-of-dev", "settings.json")).toBe("{}");
    expect(existsSync(path.join(dirOf("copy-of-dev"), "skills", "helper", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(dirOf("copy-of-dev"), "files"))).toBe(false);
    expect(orgFrames(spy)).toEqual([
      { type: "org_action", action: "template_created", by: "@hr-bot", subject: "copy-of-dev" },
    ]);
  } finally {
    spy.mockRestore();
  }
});

test("create_template refuses an existing name, a missing source and a reserved name, and writes nothing", async () => {
  expect(
    (await call("hr-bot", "create_template", { name: "dev", display_name: "Again" })).text,
  ).toBe("A template named dev already exists.");
  expect(
    (await call("hr-bot", "create_template", { name: "dev", display_name: "Self", from: "dev" }))
      .text,
  ).toBe("A template named dev already exists.");
  expect(
    (await call("hr-bot", "create_template", { name: "gone", display_name: "G", from: "nope" }))
      .text,
  ).toBe("Template nope not found.");
  const reserved = await call("hr-bot", "create_template", { name: "new", display_name: "N" });
  expect(reserved.err).toBe(true);
  expect(reserved.text).toBe(
    "Input validation error: Invalid arguments for tool create_template: name: That name is reserved.",
  );
  expect(existsSync(dirOf("new"))).toBe(false);
  expect(existsSync(dirOf("gone"))).toBe(false);
});

test("create_template from an invalid source says so and leaves no folder", async () => {
  mkdirSync(dirOf("broken"), { recursive: true });
  writeFileSync(
    path.join(dirOf("broken"), "template.yaml"),
    "name: broken\ndisplay_name: Broken\nruntime: docker\n",
  );
  writeFileSync(path.join(dirOf("broken"), "AGENTS.md"), "# Broken\n");
  writeFileSync(path.join(dirOf("broken"), "settings.json"), "{ not json");
  const r = await call("hr-bot", "create_template", {
    name: "copy-of-broken",
    display_name: "Copy",
    from: "broken",
  });
  expect(r).toMatchObject({ err: true, text: "Template broken has errors; fix it first." });
  expect(existsSync(dirOf("copy-of-broken"))).toBe(false);
});

test("write_template_file writes the file, returns its new hash, and get_template reads that hash back", async () => {
  const base = await hashOf("hr-bot", "dev", "AGENTS.md");
  const r = await call("hr-bot", "write_template_file", {
    name: "dev",
    file: "AGENTS.md",
    content: "# Developer\n\nWrite tests too.\n",
    base_hash: base,
  });
  expect(r.err).toBe(false);
  expect(read("dev", "AGENTS.md")).toBe("# Developer\n\nWrite tests too.\n");
  expect(r.json.hash).toBe(await hashOf("hr-bot", "dev", "AGENTS.md"));
  expect(r.json.hash).not.toBe(base);
});

test("write_template_file with a stale hash names the file and refuses the write", async () => {
  const before = read("dev", "template.yaml");
  const r = await call("hr-bot", "write_template_file", {
    name: "dev",
    file: "template.yaml",
    content: `${before}description: changed\n`,
    base_hash: "stale",
  });
  expect(r).toMatchObject({
    err: true,
    text: "template.yaml changed since you read it; call get_template again.",
  });
  expect(read("dev", "template.yaml")).toBe(before);
});

test("write_template_file cannot change runtime; the refusal names the field and writes nothing", async () => {
  const before = read("dev", "template.yaml");
  const r = await call("hr-bot", "write_template_file", {
    name: "dev",
    file: "template.yaml",
    content: before.replace("runtime: docker", "runtime: local"),
    base_hash: await hashOf("hr-bot", "dev", "template.yaml"),
  });
  expect(r.err).toBe(true);
  expect(r.text).toContain("runtime can only be changed by a human.");
  expect(read("dev", "template.yaml")).toBe(before);
});

test("write_template_file refuses a settings.json key outside the allowlist and leaves the file untouched", async () => {
  const before = read("dev", "settings.json");
  const r = await call("hr-bot", "write_template_file", {
    name: "dev",
    file: "settings.json",
    content: JSON.stringify({ hooks: { PreToolUse: [] } }),
    base_hash: await hashOf("hr-bot", "dev", "settings.json"),
  });
  expect(r.err).toBe(true);
  expect(r.text).toMatch(/hooks/);
  expect(read("dev", "settings.json")).toBe(before);
});

test("write_template_file refuses AGENTS.md over 256 KiB in the schema, before any write", async () => {
  const before = read("dev", "AGENTS.md");
  const r = await call("hr-bot", "write_template_file", {
    name: "dev",
    file: "AGENTS.md",
    content: "x".repeat(256 * 1024 + 1),
    base_hash: await hashOf("hr-bot", "dev", "AGENTS.md"),
  });
  expect(r.err).toBe(true);
  expect(r.text).toContain("256 KiB");
  expect(read("dev", "AGENTS.md")).toBe(before);
});

test("write_template_file publishes no org_action (template edits are events, not toasts)", async () => {
  const spy = frames();
  try {
    await call("hr-bot", "write_template_file", {
      name: "dev",
      file: "AGENTS.md",
      content: "# Developer\n",
      base_hash: await hashOf("hr-bot", "dev", "AGENTS.md"),
    });
    expect(orgFrames(spy)).toEqual([]);
  } finally {
    spy.mockRestore();
  }
});
