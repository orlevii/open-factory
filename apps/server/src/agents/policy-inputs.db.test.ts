import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { schema } from "@open-factory/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { makeTestApp } from "../test/helpers.ts";
import { seedTestPrincipal, seedTestUser } from "../test/principals.ts";
import { PolicyInputs } from "./policy-inputs.ts";

let t: Awaited<ReturnType<typeof makeTestApp>>;
let policy: PolicyInputs;

const writeTemplate = (name: string, yaml: string) => {
  const d = path.join(t.factoryHome, "templates", name);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, "template.yaml"), yaml);
  writeFileSync(path.join(d, "AGENTS.md"), `# ${name}\n`);
};

beforeAll(async () => {
  t = await makeTestApp();
  await seedTestUser(t.db, "or");
  policy = new PolicyInputs({ db: t.db });
  writeTemplate("dockertpl", "name: dockertpl\ndisplay_name: D\nruntime: docker\n");
  writeTemplate("defaulted", "name: defaulted\ndisplay_name: D\n");
  writeTemplate("localtpl", "name: localtpl\ndisplay_name: L\nruntime: local\n");
  await t.app.templates.scan();
});
afterAll(() => t.close());

test("templateRuntimes: each name's runtime, docker by default, local for a name with no valid parse", async () => {
  expect(await policy.templateRuntimes(["dockertpl", "defaulted", "localtpl", "missing"])).toEqual([
    "docker",
    "docker",
    "local",
    "local",
  ]);
});

test("templateHasLocalAgents: true for an archived local agent, and for a spawned one until it is terminated", async () => {
  const human = { kind: "human", handle: "or" } as const;
  const credId = randomUUID();
  await t.db.insert(schema.credentials).values({
    id: credId,
    name: "work",
    kind: "oauth_token",
    valueEnc: t.app.vault.seal("tok", `credentials:${credId}`),
  });
  const create = (slug: string, template: string) =>
    t.app.agents.create(
      { template, slug, displayName: slug, description: "", reportsTo: "or", credential: "work" },
      human,
    );
  expect(await policy.templateHasLocalAgents("localtpl")).toBe(false);
  await create("loc", "localtpl");
  await t.app.agents.archive("loc", human);
  expect(await policy.templateHasLocalAgents("localtpl")).toBe(true);
  expect(await policy.templateHasLocalAgents("dockertpl")).toBe(false);

  await create("boss", "dockertpl");
  const [boss] = await t.db.select().from(schema.agents).where(eq(schema.agents.slug, "boss"));
  const kid = randomUUID();
  await seedTestPrincipal(t.db, "agent", "kid", kid);
  await t.db.insert(schema.agents).values({
    id: kid,
    slug: "kid",
    displayName: "Kid",
    kind: "ephemeral",
    template: "spawned-local",
    runtime: "local",
    reportsTo: boss?.id,
    credentialId: boss?.credentialId,
  });
  expect(await policy.templateHasLocalAgents("spawned-local")).toBe(true);
  await t.db
    .update(schema.agents)
    .set({ terminatedAt: new Date(), terminatedBy: "@or" })
    .where(eq(schema.agents.id, kid));
  expect(await policy.templateHasLocalAgents("spawned-local")).toBe(false);
});
