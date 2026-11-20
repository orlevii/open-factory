import { expect, test } from "vitest";
import { templateConfigSchema, templateYamlSchema } from "./templates.ts";

test("defaults and camelCase output", () => {
  const c = templateYamlSchema.parse({ name: "tech-lead", display_name: "Tech Lead" });
  expect(c).toEqual({
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
  });
  expect(templateConfigSchema.parse(c)).toEqual(c);
});

test("strict: unknown keys and bad values are errors", () => {
  expect(
    templateYamlSchema.safeParse({ name: "x1", display_name: "X", modle: "opus" }).success,
  ).toBe(false);
  expect(
    templateYamlSchema.safeParse({ name: "x1", display_name: "X", effort: "huge" }).success,
  ).toBe(false);
  expect(
    templateYamlSchema.safeParse({ name: "x1", display_name: "X", skills: [".."] }).success,
  ).toBe(false);
  expect(
    templateYamlSchema.safeParse({ name: "x1", display_name: "X", plugins: ["nomarket"] }).success,
  ).toBe(false);
  expect(
    templateYamlSchema.safeParse({ name: "x1", display_name: "X", secrets: ["PATH"] }).success,
  ).toBe(false);
});

test("model can't start with a dash, so it can't be read as a CLI flag", () => {
  const msg = "Use a model alias or id such as haiku or claude-sonnet-4-5.";
  const yaml = (model: string) =>
    templateYamlSchema.safeParse({ name: "x1", display_name: "X", model });
  const bad = yaml("--dangerously-skip-permissions");
  expect(bad.success).toBe(false);
  expect(bad.error?.issues[0]?.message).toBe(msg);
  expect(yaml("-x").success).toBe(false);
  expect(yaml("haiku").success).toBe(true);
  expect(yaml("claude-sonnet-4-5").success).toBe(true);
  const cfg = templateYamlSchema.parse({ name: "x1", display_name: "X" });
  expect(templateConfigSchema.safeParse({ ...cfg, model: "--x" }).success).toBe(false);
  expect(templateConfigSchema.safeParse({ ...cfg, model: "haiku" }).success).toBe(true);
});
