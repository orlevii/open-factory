import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { schema } from "@open-factory/db";
import { createFakeClaude } from "@open-factory/harness/testing";
import { type Actor, LOCAL_RUNTIME_REFUSAL } from "@open-factory/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { makeTestApp } from "../test/helpers.ts";
import { type AgentService, OrgRefusedError } from "./agent-service.ts";
import type { AgentRuntimes } from "./runtimes.ts";

let t: Awaited<ReturnType<typeof makeTestApp>>;
let svc: AgentService;
let runtimes: AgentRuntimes;
let home: string;
const human: Actor = { kind: "human", handle: "or" };
let hr: Actor;

function writeTemplate(name: string, runtime: "docker" | "local") {
  const d = path.join(home, "templates", name);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    path.join(d, "template.yaml"),
    `name: ${name}\ndisplay_name: ${name}\nruntime: ${runtime}\n`,
  );
  writeFileSync(path.join(d, "AGENTS.md"), `# ${name}\n`);
}
const body = (slug: string, template = "dockertpl") => ({
  template,
  slug,
  displayName: slug,
  description: "",
  reportsTo: null,
  credential: "work",
});
const rowOf = async (slug: string) => {
  const [r] = await t.db.select().from(schema.agents).where(eq(schema.agents.slug, slug));
  return r;
};
const asAgent = async (slug: string): Promise<Actor> => {
  const r = await rowOf(slug);
  if (!r) throw new Error(`no agent ${slug}`);
  return { kind: "agent", id: r.id, slug };
};

beforeAll(async () => {
  t = await makeTestApp({
    env: { FACTORY_CLAUDE_BIN: createFakeClaude({ scenario: "reply" }).bin },
  });
  home = t.factoryHome;
  svc = t.app.agents;
  runtimes = t.app.runtimes;
  mkdtempSync(path.join(tmpdir(), "repo-"));
  const credId = randomUUID();
  await t.db.insert(schema.credentials).values({
    id: credId,
    name: "work",
    kind: "oauth_token",
    valueEnc: t.app.vault.seal("tok", `credentials:${credId}`),
  });
  writeTemplate("dockertpl", "docker");
  writeTemplate("localtpl", "local");
  await svc.create(body("hr-bot"), human);
  await svc.create(body("target"), human);
  await svc.create(body("loc", "localtpl"), human);
  hr = await asAgent("hr-bot");
});
afterAll(() => t.close());

test.each([
  ["another agent", "target"],
  ["the caller's own row", "hr-bot"],
])("an agent can't grant manage_org to %s", async (_n, slug) => {
  await expect(svc.update(slug, { manageOrg: true }, hr)).rejects.toThrow(
    new OrgRefusedError("Only a human can grant manage_org."),
  );
  expect((await rowOf(slug))?.manageOrg).toBe(false);
});

test("a human grants manage_org and the agent is asked to restart; the same value asks for nothing", async () => {
  const spy = vi.spyOn(runtimes, "requestRestart").mockResolvedValue(undefined);
  try {
    const id = (await rowOf("target"))?.id;
    expect(await svc.update("target", { manageOrg: true }, human)).toMatchObject({
      manageOrg: true,
    });
    expect(spy).toHaveBeenCalledWith(id);
    spy.mockClear();
    await svc.update("target", { manageOrg: true }, human);
    expect(spy).not.toHaveBeenCalled();
    await svc.update("target", { manageOrg: false }, human);
  } finally {
    spy.mockRestore();
  }
});

test("an agent can't archive itself", async () => {
  await expect(svc.archive("hr-bot", hr)).rejects.toThrow(
    new OrgRefusedError("Ask a human to archive you."),
  );
  expect((await rowOf("hr-bot"))?.archivedAt).toBeNull();
});

test("an agent can't unarchive an agent that can manage the org; a human can", async () => {
  await svc.create(body("boss"), human);
  await svc.update("boss", { manageOrg: true }, human);
  await svc.archive("boss", human);
  await expect(svc.unarchive("boss", hr)).rejects.toThrow(
    new OrgRefusedError("Only a human can unarchive @boss: it can manage the org."),
  );
  expect((await rowOf("boss"))?.archivedAt).not.toBeNull();
  expect(await svc.unarchive("boss", human)).toMatchObject({ archivedAt: null, manageOrg: true });
});

test("an agent can archive and unarchive an agent that can't manage the org", async () => {
  await svc.create(body("plain"), human);
  expect(await svc.archive("plain", hr)).toMatchObject({ archivedAt: expect.any(String) });
  expect(await svc.unarchive("plain", hr)).toMatchObject({ archivedAt: null });
});

test("an agent can't create from a local template, and nothing is created", async () => {
  await expect(svc.create(body("loc-2", "localtpl"), hr)).rejects.toThrow(
    new OrgRefusedError(LOCAL_RUNTIME_REFUSAL),
  );
  expect(await rowOf("loc-2")).toBeUndefined();
  expect(existsSync(path.join(home, "agents/loc-2"))).toBe(false);
});

test("an agent can't create with a can_spawn that names a local template", async () => {
  await expect(
    svc.create({ ...body("spawner"), config: { template: { can_spawn: ["localtpl"] } } }, hr),
  ).rejects.toThrow(new OrgRefusedError(LOCAL_RUNTIME_REFUSAL));
  expect(await rowOf("spawner")).toBeUndefined();
});

test("an agent can't create when the template parses local though last_valid says docker", async () => {
  writeTemplate("drifting", "docker");
  await t.app.templates.scan();
  writeTemplate("drifting", "local"); // edited on disk, not rescanned
  await expect(svc.create(body("drift-1", "drifting"), hr)).rejects.toThrow(
    new OrgRefusedError(LOCAL_RUNTIME_REFUSAL),
  );
  expect(await rowOf("drift-1")).toBeUndefined();
  expect(existsSync(path.join(home, "agents/drift-1"))).toBe(false);
});

test("a malformed can_spawn gives invalid_config, not a TypeError", async () => {
  await expect(
    svc.create({ ...body("badspawn"), config: { template: { can_spawn: "x" } } as never }, hr),
  ).rejects.toMatchObject({ code: "invalid_config" });
  expect(await rowOf("badspawn")).toBeUndefined();
});

test("an agent can't edit, archive or unarchive a local agent", async () => {
  const refused = new OrgRefusedError(LOCAL_RUNTIME_REFUSAL);
  await expect(svc.update("loc", { displayName: "Other" }, hr)).rejects.toThrow(refused);
  await expect(svc.archive("loc", hr)).rejects.toThrow(refused);
  await svc.archive("loc", human);
  await expect(svc.unarchive("loc", hr)).rejects.toThrow(refused);
  await svc.unarchive("loc", human);
  expect((await rowOf("loc"))?.displayName).toBe("loc");
});

test("a human can create from a local template", async () => {
  expect(await svc.create(body("loc-h", "localtpl"), human)).toMatchObject({ runtime: "local" });
});

test("create stores the overlay as the agent's initial config", async () => {
  await svc.create({ ...body("tuned"), config: { template: { model: "opus" } } }, hr);
  expect((await rowOf("tuned"))?.config).toEqual({ template: { model: "opus" } });
});

test("create with a config the agent policy refuses creates nothing", async () => {
  await expect(
    svc.create(
      { ...body("proxied"), config: { settings: { env: { HTTPS_PROXY: "http://x" } } } },
      hr,
    ),
  ).rejects.toMatchObject({
    code: "invalid_config",
    extra: {
      issues: [expect.objectContaining({ message: "HTTPS_PROXY can only be set by a human." })],
    },
  });
  expect(await rowOf("proxied")).toBeUndefined();
  expect(existsSync(path.join(home, "agents/proxied"))).toBe(false);
  // Positive control: a human creates with the same env.
  await svc.create(
    { ...body("proxied-h"), config: { settings: { env: { HTTPS_PROXY: "http://x" } } } },
    human,
  );
  expect(await rowOf("proxied-h")).toBeDefined();
});

test("create with a config that fails the schema creates nothing, for a human too", async () => {
  await expect(
    svc.create({ ...body("badcfg"), config: { nope: 1 } as never }, human),
  ).rejects.toMatchObject({ code: "invalid_config" });
  expect(await rowOf("badcfg")).toBeUndefined();
});

test("a null manager from an agent is top level", async () => {
  expect(await svc.create({ ...body("top"), reportsTo: null }, hr)).toMatchObject({
    reportsTo: null,
    depth: 0,
  });
});

test("description_by names the agent that last wrote the description; a human edit clears it", async () => {
  await svc.update("target", { description: "by agent" }, hr);
  if (hr.kind !== "agent") throw new Error("hr is an agent");
  expect((await rowOf("target"))?.descriptionBy).toBe(hr.id);
  await svc.update("target", { description: "by human" }, human);
  expect((await rowOf("target"))?.descriptionBy).toBeNull();
});
