import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { schema } from "@open-factory/db";
import type { Actor } from "@open-factory/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { seedTestUser } from "../test/handles.ts";
import { makeTestApp } from "../test/helpers.ts";
import { OrgRefusedError } from "./errors.ts";

/** Switching an agent between Docker and local (its Configure page): a human's explicit act, with the local rules. */

const human: Actor = { kind: "human", handle: "or" };

async function factory(env: Record<string, string> = {}) {
  const t = await makeTestApp({ env });
  await seedTestUser(t.db);
  const credId = randomUUID();
  await t.db.insert(schema.credentials).values({
    id: credId,
    name: "work",
    kind: "oauth_token",
    valueEnc: t.app.vault.seal("tok", `credentials:${credId}`),
  });
  const template = (name: string, yaml: string) => {
    const d = path.join(t.factoryHome, "templates", name);
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, "template.yaml"), `name: ${name}\ndisplay_name: ${name}\n${yaml}`);
    writeFileSync(path.join(d, "AGENTS.md"), `# ${name}\n`);
  };
  const create = (slug: string, tpl: string) =>
    t.app.agents.create(
      { template: tpl, slug, displayName: slug, description: "", reportsTo: "or", credential: "work" },
      human,
    );
  const runtimeOf = async (slug: string) =>
    (await t.db.select().from(schema.agents).where(eq(schema.agents.slug, slug)))[0]?.runtime;
  return { t, template, create, runtimeOf };
}

describe("on a factory that allows local agents", () => {
  let f: Awaited<ReturnType<typeof factory>>;
  beforeAll(async () => {
    f = await factory();
    f.template("dock", "runtime: docker\n");
    f.template("loc", "runtime: local\n");
    f.template("bypass", "runtime: docker\npermission_mode: bypass\n");
  });
  afterAll(() => f.t.close());

  test("a human switches an agent to local: the agent row changes and the agent restarts", async () => {
    await f.create("mover", "dock");
    const spy = vi.spyOn(f.t.app.runtimes, "requestRestart").mockResolvedValue(undefined);
    try {
      expect(await f.t.app.agents.update("mover", { runtime: "local" }, human)).toMatchObject({
        runtime: "local",
      });
      expect(await f.runtimeOf("mover")).toBe("local");
      expect(spy).toHaveBeenCalledOnce();
      spy.mockClear();
      await f.t.app.agents.update("mover", { runtime: "local" }, human);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test.each([
    ["into local", "dock", "local"],
    ["out of local", "loc", "docker"],
  ] as const)("an agent can't switch another agent %s", async (_n, tpl, to) => {
    const slug = `target-${to}`;
    await f.create(slug, tpl);
    await f.create(`asker-${to}`, "dock");
    const [asker] = await f.t.db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.slug, `asker-${to}`));
    if (!asker) throw new Error("no asker");
    const before = await f.runtimeOf(slug);
    await expect(
      f.t.app.agents.update(slug, { runtime: to }, { kind: "agent", id: asker.id, slug: asker.slug }),
    ).rejects.toBeInstanceOf(OrgRefusedError);
    expect(await f.runtimeOf(slug)).toBe(before);
  });

  test("a template in Bypass mode keeps its agents in Docker: 400 on runtime", async () => {
    await f.create("byp", "bypass");
    const res = await f.t.app.inject({
      method: "PATCH",
      url: "/api/agents/byp",
      headers: { cookie: (await f.t.signUpUser({ handle: "or-bp" })).cookie },
      payload: { runtime: "local" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.fields).toEqual({ runtime: "Bypass mode needs Docker." });
    expect(await f.runtimeOf("byp")).toBe("docker");
  });

  test("Combined shows the agent's runtime, not its template's", async () => {
    await f.create("stayer", "loc");
    await f.t.app.agents.update("stayer", { runtime: "docker" }, human);
    const view = await f.t.app.configs.getConfig("stayer");
    expect(view.template.doc?.template.runtime).toBe("local");
    expect(view.merged?.template.runtime).toBe("docker");
  });
});

test("a factory that doesn't allow local agents refuses the switch: 400 on runtime", async () => {
  const f = await factory({ FACTORY_ALLOW_LOCAL_RUNTIME: "false" });
  try {
    f.template("dock", "runtime: docker\n");
    await f.create("held", "dock");
    const res = await f.t.app.inject({
      method: "PATCH",
      url: "/api/agents/held",
      headers: { cookie: (await f.t.signUpUser({ handle: "or-off" })).cookie },
      payload: { runtime: "local" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.fields).toEqual({ runtime: "Local is off on this factory." });
    expect(await f.runtimeOf("held")).toBe("docker");
  } finally {
    await f.t.close();
  }
});
