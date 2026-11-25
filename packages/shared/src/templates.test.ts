import { expect, test } from "vitest";
import { imageRefSchema, templateConfigSchema, templateYamlSchema } from "./templates.ts";

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
    secrets: [],
    canSpawn: [],
    maxLiveSpawns: 5,
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
    templateYamlSchema.safeParse({ name: "x1", display_name: "X", secrets: ["PATH"] }).success,
  ).toBe(false);
});

test("model can't start with a dash, so it can't be read as a CLI flag", () => {
  const msg = "Can't start with a dash.";
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

test("image: only a Docker image reference", () => {
  const ok = [
    "open-factory-base:dev",
    "ghcr.io/orlevii/open-factory/base:latest",
    "localhost:5000/team/img",
    "ubuntu",
    "my_org/my-img:1.2.3",
    `ghcr.io/org/img@sha256:${"a".repeat(64)}`,
    `ghcr.io/org/img:v1@sha256:${"0".repeat(64)}`,
  ];
  for (const image of ok) {
    expect(templateYamlSchema.parse({ name: "tl", display_name: "T", image }).image).toBe(image);
    expect(imageRefSchema.safeParse(image).success).toBe(true);
  }
  const bad = [
    "../../containers/json",
    "img/../x",
    "a..b",
    "img:tag?all=1",
    "img#frag",
    "img tag",
    " img",
    "Upper/Case",
    "img:",
    "img@sha256:short",
    `img@sha256:${"0123456789abcdef".repeat(2)}`,
    `img@sha256:${"A".repeat(64)}`,
    `img@sha512:${"a".repeat(128)}`,
    "/img",
    "img/",
    `img:${"t".repeat(129)}`,
  ];
  for (const image of bad) {
    expect(imageRefSchema.safeParse(image).success, image).toBe(false);
    expect(templateYamlSchema.safeParse({ name: "tl", display_name: "T", image }).success).toBe(
      false,
    );
  }
  const base = templateYamlSchema.parse({ name: "tl", display_name: "T" });
  expect(templateConfigSchema.safeParse({ ...base, image: "x/../y" }).success).toBe(false);
  expect(templateConfigSchema.safeParse({ ...base, image: "x/y:1" }).success).toBe(true);
});

test("image: the open-factory-user/ tag is refused, pointing to the bare name", () => {
  const r = imageRefSchema.safeParse("open-factory-user/playwright:latest");
  expect(r.success).toBe(false);
  expect(r.error?.issues[0]?.message).toBe("Use the bare name playwright for a user image.");
  expect(imageRefSchema.safeParse("playwright").success).toBe(true);
  expect(imageRefSchema.safeParse("ghcr.io/open-factory-user/x:1").success).toBe(true);
});

test("warm_window_minutes has no default and is kept when set", () => {
  const base = { name: "x1", display_name: "X" };
  expect("warmWindowMinutes" in templateYamlSchema.parse(base)).toBe(false);
  expect(templateYamlSchema.parse({ ...base, warm_window_minutes: 30 }).warmWindowMinutes).toBe(30);
});
