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
