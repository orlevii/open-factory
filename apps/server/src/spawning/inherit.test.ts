import { templateConfigSchema } from "@open-factory/shared";
import { expect, test } from "vitest";
import { droppedNote, inheritFrom, readDenyRules, type SpawnerState } from "./inherit.ts";

const tpl = (o: object) =>
  templateConfigSchema.parse({
    name: "tech-lead",
    displayName: "Tech Lead",
    description: "",
    runtime: "docker",
    permissionMode: "auto",
    projects: [],
    skills: [],
    localSkills: true,
    plugins: [],
    secrets: [],
    canSpawn: [],
    maxLiveSpawns: 5,
    warmWindowMinutes: 70,
    ...o,
  });
const none = { permissionsDeny: [], softDeny: [], hardDeny: [] };
const spawner = (o: Partial<SpawnerState> = {}): SpawnerState => ({
  runtime: "docker",
  permissionMode: "auto",
  credentialId: "c1",
  grants: [
    { id: "p1", name: "app", hostPath: "/r/app" },
    { id: "p2", name: "web", hostPath: "/r/web" },
  ],
  secrets: ["GH_TOKEN"],
  deny: { permissionsDeny: ["Bash(rm:*)"], softDeny: [], hardDeny: ["no prod"] },
  ...o,
});
const env = { localRuntimeAllowed: true };

test("credential, projects ∩, secrets ∩, deny ∪", () => {
  const r = inheritFrom(
    spawner(),
    tpl({ projects: ["app", "docs"], secrets: ["GH_TOKEN", "NPM_TOKEN"] }),
    { permissionsDeny: ["Read(.env)"], softDeny: ["x"], hardDeny: [] },
    env,
  );
  expect(r).toEqual({
    ok: true,
    credentialId: "c1",
    grants: [{ id: "p1", name: "app", hostPath: "/r/app" }],
    secrets: ["GH_TOKEN"],
    deny: { permissionsDeny: ["Read(.env)", "Bash(rm:*)"], softDeny: ["x"], hardDeny: ["no prod"] },
    dropped: { secrets: ["NPM_TOKEN"], projects: ["docs"] },
  });
});
test.each([
  [
    spawner({ runtime: "docker" }),
    tpl({ runtime: "local" }),
    env,
    "Template tech-lead runs locally, outside the sandbox you run in, so you can't spawn it.",
  ],
  [
    spawner({ runtime: "local" }),
    tpl({ runtime: "local" }),
    { localRuntimeAllowed: false },
    "Template tech-lead needs the local runtime, which this factory doesn't allow.",
  ],
  [
    spawner({ permissionMode: "auto" }),
    tpl({ permissionMode: "bypass" }),
    env,
    "Template tech-lead runs without permission checks, which you don't have, so you can't spawn it.",
  ],
])("refusal %#", (s, c, e, refusal) => {
  expect(inheritFrom(s, c, none, e)).toEqual({ ok: false, refusal });
});
test("allowed: local from local (gate on), bypass from bypass", () => {
  expect(inheritFrom(spawner({ runtime: "local" }), tpl({ runtime: "local" }), none, env).ok).toBe(
    true,
  );
  expect(
    inheritFrom(spawner({ permissionMode: "bypass" }), tpl({ permissionMode: "bypass" }), none, env)
      .ok,
  ).toBe(true);
});
test("readDenyRules drops $defaults and non-strings", () => {
  expect(
    readDenyRules({
      permissions: { deny: ["A", 3] },
      autoMode: { soft_deny: ["$defaults", "s"], hard_deny: ["h"] },
    }),
  ).toEqual({ permissionsDeny: ["A"], softDeny: ["s"], hardDeny: ["h"] });
});
test("droppedNote only when something was dropped", () => {
  expect(droppedNote({ secrets: [], projects: [] })).toBeUndefined();
  expect(droppedNote({ secrets: ["GH_TOKEN"], projects: ["app"] })).toBe(
    "Not passed on, because you don't hold them: secrets GH_TOKEN; projects app.",
  );
});
