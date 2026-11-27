import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { schema } from "@open-factory/db";
import type { ServerMessage } from "@open-factory/shared";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { fileHash, type TemplateChange } from "../templates/template-index.ts";
import { makeTestApp } from "../test/helpers.ts";

const SECRET = "sk-ant-oat01-SECRETSHAPED0123456789";
const YAML = `# my template
name: dev
display_name: Dev # shown in the UI
runtime: docker
model: opus
description: keep me
`;

let h: Awaited<ReturnType<typeof makeTestApp>>;
let cookie: string;
const dir = () => path.join(h.factoryHome, "templates/dev");
const file = (f: string) => path.join(dir(), f);
const read = (f: string) => readFileSync(file(f), "utf8");
const changes: TemplateChange[] = [];
const frames: ServerMessage[] = [];

beforeAll(async () => {
  h = await makeTestApp();
  cookie = (await h.signUpUser({ handle: "or" })).cookie;
  h.app.templates.onChange((e) => void changes.push(e));
  h.app.bus.subscribeAll((m) => void frames.push(m));
});
afterAll(() => h.close());

const reset = async () => {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(file("template.yaml"), YAML);
  writeFileSync(file("AGENTS.md"), "# Dev\n");
  for (const f of ["settings.json", "mcp.json"]) await rmIf(file(f));
  mkdirSync(path.join(dir(), "skills/mine"), { recursive: true });
  await h.app.templates.scanOne("dev");
  await settle();
  changes.length = 0;
  frames.length = 0;
};
const rmIf = async (p: string) => {
  const { rm } = await import("node:fs/promises");
  await rm(p, { force: true, recursive: true });
};
/** The dispatch chain runs in microtasks after the scan; let it drain. */
const settle = () => new Promise((r) => setTimeout(r, 50));

const call = (method: "GET" | "PUT", payload?: object) =>
  h.app.inject({
    method,
    url: "/api/templates/dev/config",
    headers: { cookie },
    ...(payload ? { payload } : {}),
  });
type Cfg = {
  doc: { template: Record<string, unknown>; settings: object; mcp: { mcpServers: object } } | null;
  hashes: Record<string, string | null>;
  issues: { message: string; path?: string }[];
  localSkills: string[];
  agents: { live: number; archived: number; cantStart: number };
};
const get = async () => (await call("GET")).json() as Cfg;
const put = async (edit: (c: NonNullable<Cfg["doc"]>) => void, hashes?: Cfg["hashes"]) => {
  const c = await get();
  const doc = structuredClone(c.doc as NonNullable<Cfg["doc"]>);
  edit(doc);
  return call("PUT", { doc, baseHashes: hashes ?? c.hashes });
};

test("GET returns the doc without the derived key, hashes, local skills and counts", async () => {
  await reset();
  const c = await get();
  expect(c.issues).toEqual([]);
  expect(c.doc?.template).toEqual({
    name: "dev",
    display_name: "Dev",
    runtime: "docker",
    model: "opus",
    description: "keep me",
  });
  expect(JSON.stringify(c.doc)).not.toContain("local_skill_names");
  expect(c.localSkills).toEqual(["mine"]);
  expect(c.hashes).toMatchObject({ "mcp.json": null });
  expect(c.hashes["template.yaml"]).toMatch(/^[0-9a-f]{64}$/);
  expect(c.hashes["settings.json"]).toBeNull();
  expect(c.agents).toEqual({ live: 0, archived: 0, cantStart: 0 });
});

test("GET counts live and archived agents; only an invalid template has agents that can't start", async () => {
  await reset();
  await h.seedAgent({ handle: "ana" });
  await h.seedAgent({ handle: "bob" });
  await h.seedAgent({ handle: "cy" });
  await h.db.update(schema.agents).set({ template: "dev" });
  await h.db
    .update(schema.agents)
    .set({ archivedAt: new Date() })
    .where(eq(schema.agents.id, sql`(select id from principals where handle = ${"cy"})`));
  await h.db
    .update(schema.agents)
    .set({ config: { bogus: SECRET } as never })
    .where(eq(schema.agents.id, sql`(select id from principals where handle = ${"bob"})`));
  const ok = await get();
  expect(ok.agents).toEqual({ live: 2, archived: 1, cantStart: 0 });
  writeFileSync(file("settings.json"), "{");
  const broken = await get();
  expect(broken.doc).toBeNull();
  expect(broken.agents).toEqual({ live: 2, archived: 1, cantStart: 2 });
  expect(broken.issues.some((i) => i.message.startsWith("JSON"))).toBe(true);
  await reset();
  await h.db.delete(schema.agents);
});

test("malformed files never echo their text in the issues", async () => {
  for (const [f, text] of [
    ["settings.json", `{"k": ${SECRET}}`],
    ["mcp.json", `{"mcpServers": {"gh": {"env": {"T": ${SECRET}}}}}`],
    ["template.yaml", `name: dev\ndisplay_name: ${SECRET}: x\n`],
    ["template.yaml", `name: dev\ndisplay_name: Dev\nmodel: *${SECRET}\n`],
    ["template.yaml", `%YAML ${SECRET}\n---\nname: dev\n`],
  ] as const) {
    await reset();
    writeFileSync(file(f), text);
    const r = await call("GET");
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain("SECRETSHAPED");
    expect((r.json() as Cfg).issues.length).toBeGreaterThan(0);
  }
  await reset();
});

test("404 for a template that doesn't exist", async () => {
  const r = await h.app.inject({
    method: "GET",
    url: "/api/templates/nope/config",
    headers: { cookie },
  });
  expect(r.statusCode).toBe(404);
  expect(r.json().error.code).toBe("template_not_found");
});

test("PUT sets and deletes only the owned keys: comments, order and other keys survive", async () => {
  await reset();
  const r = await put((d) => {
    delete d.template.model;
    d.template.effort = "high";
    d.template.skills = [];
    d.template.display_name = "Changed"; // not form-owned: ignored
    d.template.sneaky = 1; // unknown: never written
    d.template.local_skill_names = ["x"]; // derived: never written
  });
  expect(r.statusCode).toBe(200);
  const yaml = read("template.yaml");
  expect(yaml).toContain("# my template");
  expect(yaml).toMatch(/display_name: Dev +# shown in the UI/);
  expect(yaml).toContain("description: keep me");
  expect(yaml).not.toMatch(/^model:/m);
  expect(yaml).toMatch(/^effort: high$/m);
  expect(yaml).not.toContain("sneaky");
  expect(yaml).not.toContain("local_skill_names");
  const body = r.json();
  expect(body.issues).toEqual([]);
  expect(body.hashes).toEqual((await get()).hashes);
});

test("a stale base hash is 409 changed_on_disk with today's hashes, and nothing is written", async () => {
  await reset();
  const c = await get();
  writeFileSync(file("template.yaml"), `${YAML}# edited elsewhere\n`);
  const r = await call("PUT", { doc: c.doc, baseHashes: c.hashes });
  expect(r.statusCode).toBe(409);
  expect(r.json().error.code).toBe("changed_on_disk");
  expect(r.json().error.currentHashes["template.yaml"]).toBe((await get()).hashes["template.yaml"]);
  expect(read("template.yaml")).toBe(`${YAML}# edited elsewhere\n`);
  // A file that appeared since also counts.
  await reset();
  const d = await get();
  writeFileSync(file("mcp.json"), '{"mcpServers":{}}');
  expect((await call("PUT", { doc: d.doc, baseHashes: d.hashes })).statusCode).toBe(409);
});

test("an invalid mcp.json in the doc is a 400 and template.yaml stays untouched", async () => {
  await reset();
  const before = read("template.yaml");
  const r = await put((d) => {
    d.template.effort = "high";
    d.mcp.mcpServers = { factory: { command: "node", args: [SECRET], env: { K: SECRET } } };
  });
  expect(r.statusCode).toBe(400);
  expect(r.json().error.code).toBe("invalid_config");
  expect(r.json().error.issues[0]).toMatchObject({ file: "mcp.json", severity: "error" });
  expect(read("template.yaml")).toBe(before);
  expect(existsSync(file("mcp.json"))).toBe(false);
  expect(changes).toEqual([]);
});

test("validation never echoes a secret value, key or url", async () => {
  await reset();
  const leaks = async (edit: (d: NonNullable<Cfg["doc"]>) => void) => {
    const r = await put(edit);
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toContain("SECRETSHAPED");
    expect(r.body).not.toContain("hunter2");
  };
  await leaks((d) => {
    d.settings = { env: { [`${SECRET}`]: "hunter2", OPEN_FACTORY_X: SECRET } };
  });
  await leaks((d) => {
    d.mcp.mcpServers = {
      factory: {
        command: SECRET,
        args: [SECRET],
        url: `https://x.example/${SECRET}`,
        headers: { Authorization: `Bearer ${SECRET}` },
        env: { K: SECRET },
      },
    };
  });
  await leaks((d) => {
    d.template.model = `${SECRET}!`;
    d.template.skills = [SECRET];
    Object.assign(d.settings, { enabledPlugins: { [`${SECRET}@${SECRET}`]: true } });
  });
  expect(read("template.yaml")).toBe(YAML);
});

test("mcp.json keys other than mcpServers survive a save", async () => {
  await reset();
  writeFileSync(file("mcp.json"), '{"mcpServers":{"gh":{"command":"npx"}},"inputs":[{"id":"x"}]}');
  const c = await get();
  expect(c.doc?.mcp).toHaveProperty("inputs");
  const r = await put((d) => {
    d.template.effort = "low";
    d.mcp.mcpServers = {};
  });
  expect(r.statusCode).toBe(200);
  expect(JSON.parse(read("mcp.json"))).toEqual({ mcpServers: {}, inputs: [{ id: "x" }] });
  // Even a client that sends only mcpServers can't drop them.
  const d2 = await get();
  await call("PUT", {
    doc: { ...d2.doc, mcp: { mcpServers: { a: { command: "x" } } } },
    baseHashes: d2.hashes,
  });
  expect(JSON.parse(read("mcp.json"))).toEqual({
    mcpServers: { a: { command: "x" } },
    inputs: [{ id: "x" }],
  });
});

test("a failed write leaves no temp files and still re-indexes", async () => {
  await reset();
  mkdirSync(file("settings.json")); // a directory: its rename can't succeed
  const c = await get();
  const r = await call("PUT", {
    doc: { ...c.doc, settings: { a: 1 }, template: { ...c.doc?.template, effort: "low" } },
    baseHashes: c.hashes,
  });
  expect(r.statusCode).toBeGreaterThanOrEqual(500);
  expect(readdirSync(dir()).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  // The re-index follows the disk: the hashes GET reports are those of the files as they are now.
  const after = await get();
  expect(after.hashes["template.yaml"]).toBe(fileHash(readFileSync(file("template.yaml"))));
  await rmIf(file("settings.json"));
});

test("only changed files are written; an absent mcp.json is not created for empty servers", async () => {
  await reset();
  writeFileSync(file("settings.json"), '{"a":1}');
  const before = (await get()).hashes;
  const r = await put((d) => {
    d.template.effort = "low";
  });
  expect(r.statusCode).toBe(200);
  const after = r.json().hashes;
  expect(after["template.yaml"]).not.toBe(before["template.yaml"]);
  expect(after["settings.json"]).toBe(before["settings.json"]);
  expect(after["mcp.json"]).toBeNull();
  expect(existsSync(file("mcp.json"))).toBe(false);
  // Settings of the same content in a different layout are left alone.
  writeFileSync(file("settings.json"), '{ "a" : 1 }');
  const h2 = (await get()).hashes;
  await put((d) => {
    d.template.effort = "high";
  }, h2);
  expect(read("settings.json")).toBe('{ "a" : 1 }');
  // A real settings change writes it, and a server creates mcp.json.
  const r3 = await put((d) => {
    d.settings = { a: 2 };
    d.mcp.mcpServers = { gh: { command: "npx" } };
  });
  expect(r3.statusCode).toBe(200);
  expect(JSON.parse(read("settings.json"))).toEqual({ a: 2 });
  expect(JSON.parse(read("mcp.json"))).toEqual({ mcpServers: { gh: { command: "npx" } } });
});

test("one save fires the template change once, with the caller's handle, and the WS frame at once", async () => {
  await reset();
  const r = await put((d) => {
    d.template.effort = "max";
    d.settings = { x: 1 };
    d.mcp.mcpServers = { gh: { command: "npx" } };
  });
  expect(r.statusCode).toBe(200);
  // The frame is published before the change flow is awaited.
  expect(frames).toContainEqual({ type: "config_changed", template: "dev" });
  await vi.waitFor(() => expect(changes.length).toBe(1));
  await settle();
  expect(changes.length).toBe(1);
  expect(changes[0]).toMatchObject({ name: "dev", by: expect.stringMatching(/^<@[0-9a-z]{8}>$/) });
});

test("a save that changes nothing writes nothing", async () => {
  await reset();
  const before = (await get()).hashes;
  const r = await put(() => {});
  expect(r.statusCode).toBe(200);
  expect(r.json().hashes).toEqual(before);
  expect(read("template.yaml")).toBe(YAML);
  await settle();
  expect(changes).toEqual([]);
  // Nothing changed, so open pages aren't told to refetch.
  expect(frames).not.toContainEqual({ type: "config_changed", template: "dev" });
});

test("PUT on a missing template is 404; a body with a bad shape is 400", async () => {
  await reset();
  const c = await get();
  const r = await h.app.inject({
    method: "PUT",
    url: "/api/templates/nope/config",
    headers: { cookie },
    payload: { doc: c.doc, baseHashes: c.hashes },
  });
  expect(r.statusCode).toBe(404);
  expect((await call("PUT", { doc: {}, baseHashes: c.hashes })).statusCode).toBe(400);
});
