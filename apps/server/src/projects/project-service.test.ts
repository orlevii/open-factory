import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { schema } from "@open-factory/db";
import { MSG } from "@open-factory/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { FIELD_MSG } from "../field-messages.ts";
import { agentRecords } from "../principals/principal-store.ts";
import { makeTestApp } from "../test/helpers.ts";
import { seedTestPrincipal } from "../test/principals.ts";
import { ProjectService } from "./project-service.ts";

let t: Awaited<ReturnType<typeof makeTestApp>>;
let svc: ProjectService;
const restarts: string[] = [];
let root: string;

beforeAll(async () => {
  t = await makeTestApp();
  const runtimes = { requestRestart: async (id: string) => void restarts.push(id) };
  svc = new ProjectService({
    db: t.db,
    runtimes: runtimes as never,
    templates: t.app.templates,
  });
  root = mkdtempSync(path.join(tmpdir(), "of-proj-"));
});
afterAll(() => t.close());

const dir = (name: string) => {
  const d = path.join(root, name);
  mkdirSync(d, { recursive: true });
  return d;
};

async function grant(handle: string, project: string, archived = false) {
  const a = await t.seedAgent({ handle });
  if (archived)
    await t.db
      .update(schema.agents)
      .set({ archivedAt: new Date() })
      .where(eq(schema.agents.id, a.id));
  const [p] = await t.db.select().from(schema.projects).where(eq(schema.projects.name, project));
  await t.db.insert(schema.agentProjectGrants).values({ agentId: a.id, projectId: p?.id ?? "" });
  return a.id;
}

test("create stores the realpath of a symlinked folder", async () => {
  const real = dir("real-app");
  const link = path.join(root, "link-app");
  symlinkSync(real, link);
  const p = await svc.create({ name: "app", hostPath: link });
  expect(p).toEqual({
    name: "app",
    hostPath: realpathSync(real),
    grantedTo: [],
    archivedGrantedTo: [],
    templates: [],
  });
});

test("a missing path or a file path is a hostPath field error", async () => {
  await expect(svc.create({ name: "x", hostPath: "/x" })).rejects.toMatchObject({
    status: 400,
    code: "validation_error",
    message: FIELD_MSG.noFolder,
    extra: { fields: { hostPath: FIELD_MSG.noFolder } },
  });
  const file = path.join(root, "a-file");
  writeFileSync(file, "hi");
  await expect(svc.create({ name: "x", hostPath: file })).rejects.toMatchObject({
    message: FIELD_MSG.noFolder,
  });
  for (const bad of ["relative/dir", "~other/x"]) {
    await expect(svc.create({ name: "x", hostPath: bad })).rejects.toMatchObject({
      extra: { fields: { hostPath: MSG.hostPathStart } },
    });
  }
});

test("~/… is stored as the realpath under HOME; update with ~ to the same folder is a no-op", async () => {
  const home = dir("home");
  mkdirSync(path.join(home, "code", "tilde"), { recursive: true });
  vi.stubEnv("HOME", home);
  try {
    const p = await svc.create({ name: "tilde", hostPath: "~/code/tilde" });
    expect(p.hostPath).toBe(realpathSync(path.join(home, "code/tilde")));
    const again = await svc.update("tilde", "~/code/tilde");
    expect(again.hostPath).toBe(p.hostPath);
  } finally {
    vi.unstubAllEnvs();
  }
});

test("duplicate name is 409 project_exists; duplicate path is a hostPath field error", async () => {
  await expect(svc.create({ name: "app", hostPath: dir("other") })).rejects.toMatchObject({
    status: 409,
    code: "project_exists",
  });
  await expect(
    svc.create({ name: "second", hostPath: path.join(root, "link-app") }),
  ).rejects.toMatchObject({
    code: "validation_error",
    message: FIELD_MSG.folderInUse,
    extra: { fields: { hostPath: FIELD_MSG.folderInUse } },
  });
});

test("update re-points the folder and restarts exactly the granted active agents", async () => {
  const a = await grant("alpha", "app");
  await grant("gone", "app", true);
  restarts.length = 0;
  const moved = dir("moved");
  const p = await svc.update("app", moved);
  expect(p.hostPath).toBe(realpathSync(moved));
  expect(p.grantedTo).toEqual(["alpha"]);
  expect(p.archivedGrantedTo).toEqual(["gone"]);
  expect(restarts).toEqual([a]);
  await expect(svc.update("ghost", moved)).rejects.toMatchObject({
    status: 404,
    code: "project_not_found",
    message: "No project named ghost.",
  });
  await svc.create({ name: "web", hostPath: dir("web") });
  await expect(svc.update("web", moved)).rejects.toMatchObject({
    message: FIELD_MSG.folderInUse,
  });
});

test("remove while granted is 409 project_in_use; archived holders listed separately", async () => {
  await svc.create({ name: "held", hostPath: dir("held") });
  await grant("holder", "held", true);
  await expect(svc.remove("held")).rejects.toMatchObject({
    status: 409,
    code: "project_in_use",
    message: "Archived agents @holder still hold a grant.",
    extra: { grantedTo: [], archivedGrantedTo: ["holder"], templates: [] },
  });
  await grant("h1", "held");
  await grant("h2", "held");
  await expect(svc.remove("held")).rejects.toMatchObject({
    message:
      "Granted to @h1, @h2. Remove the grant first. Archived agents @holder still hold a grant.",
    extra: { grantedTo: ["h1", "h2"], archivedGrantedTo: ["holder"], templates: [] },
  });
});

test("an FK violation from a racing grant maps to 409 project_in_use", async () => {
  await svc.create({ name: "racy", hostPath: dir("racy") });
  await grant("racer", "racy");
  const spy = (await import("vitest")).vi
    .spyOn(svc as unknown as { grants: (id: string) => Promise<unknown> }, "grants")
    .mockResolvedValueOnce({ active: [], archived: [] });
  try {
    await expect(svc.remove("racy")).rejects.toMatchObject({
      status: 409,
      code: "project_in_use",
      extra: { grantedTo: ["racer"], archivedGrantedTo: [], templates: [] },
    });
  } finally {
    spy.mockRestore();
  }
});

test("a live spawned grantee blocks removal and is named with its spawner", async () => {
  await svc.create({ name: "kids", hostPath: dir("kids") });
  await grant("boss", "kids");
  const proj = (
    await t.db.select().from(schema.projects).where(eq(schema.projects.name, "kids"))
  )[0];
  const [boss] = await agentRecords(t.db).where(eq(schema.principals.handle, "boss"));
  const [cred] = await t.db.select().from(schema.credentials).limit(1);
  const kid = (handle: string) => ({
    id: `${handle}-id`,
    handle,
    displayName: handle,
    template: "t",
    config: {} as never,
    runtime: "local" as const,
    kind: "ephemeral",
    reportsTo: boss?.id as string,
    credentialId: cred?.id ?? null,
  });
  await seedTestPrincipal(t.db, "agent", "tl-ab12", "tl-ab12-id");
  await t.db.insert(schema.agents).values(kid("tl-ab12"));
  await t.db
    .insert(schema.agentProjectGrants)
    .values({ agentId: "tl-ab12-id", projectId: proj?.id ?? "" });
  await t.db
    .delete(schema.agentProjectGrants)
    .where(eq(schema.agentProjectGrants.agentId, boss?.id ?? ""));
  await expect(svc.remove("kids")).rejects.toMatchObject({
    status: 409,
    code: "project_in_use",
    message: "Granted to @tl-ab12 (spawned by @boss); change @boss's grants or terminate it first.",
  });
  await t.db
    .delete(schema.agentProjectGrants)
    .where(eq(schema.agentProjectGrants.agentId, "tl-ab12-id"));
  await svc.remove("kids");
});

test("remove when unused works; unknown is 404", async () => {
  await svc.create({ name: "spare", hostPath: dir("spare") });
  await svc.remove("spare");
  expect((await svc.list()).map((p) => p.name)).not.toContain("spare");
  await expect(svc.remove("spare")).rejects.toMatchObject({ status: 404 });
});

test("list includes the templates that list the project", async () => {
  const d = path.join(t.factoryHome, "templates/uses-app");
  mkdirSync(d, { recursive: true });
  writeFileSync(
    path.join(d, "template.yaml"),
    "name: uses-app\ndisplay_name: U\nruntime: local\nprojects:\n  - app\n",
  );
  writeFileSync(path.join(d, "AGENTS.md"), "# u\n");
  await t.app.templates.scan();
  const list = await svc.list();
  expect(list.find((p) => p.name === "app")?.templates).toEqual(["uses-app"]);
  expect(list.find((p) => p.name === "web")?.templates).toEqual([]);
});

test("remove lists the templates that name the project", async () => {
  await svc.create({ name: "tpl-held", hostPath: dir("tpl-held") });
  await grant("tpl-holder", "tpl-held");
  const d = path.join(t.factoryHome, "templates", "uses-held");
  mkdirSync(d, { recursive: true });
  writeFileSync(
    path.join(d, "template.yaml"),
    "name: uses-held\ndisplay_name: U\nruntime: local\nprojects: [tpl-held]\n",
  );
  writeFileSync(path.join(d, "AGENTS.md"), "# u\n");
  await t.app.templates.scan();
  await expect(svc.remove("tpl-held")).rejects.toMatchObject({
    code: "project_in_use",
    extra: { grantedTo: ["tpl-holder"], archivedGrantedTo: [], templates: ["uses-held"] },
  });
});

test("update with an unchanged path restarts nobody; one failed restart does not abort the rest", async () => {
  await svc.create({ name: "same", hostPath: dir("same") });
  const a = await grant("same-a", "same");
  const b = await grant("same-b", "same");
  restarts.length = 0;
  await svc.update("same", dir("same"));
  expect(restarts).toEqual([]);
  const failing = new ProjectService({
    db: t.db,
    runtimes: {
      requestRestart: async (id: string) => {
        if (id === a) throw new Error("boom");
        restarts.push(id);
      },
    } as never,
    templates: t.app.templates,
  });
  const p = await failing.update("same", dir("same-moved"));
  expect(p.hostPath).toBe(realpathSync(dir("same-moved")));
  expect(restarts).toEqual([b]);
});
