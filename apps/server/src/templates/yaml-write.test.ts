import { expect, test } from "vitest";
import { parse } from "yaml";
import { applyConfigToYaml } from "./yaml-write.ts";

const SRC = `# The dev template.
name: dev
display_name: Dev   # shown in the UI
runtime: docker
model: opus # pinned
skills:
  - tdd
secrets: [GH_TOKEN]
custom_key: keep me
`;

test("comments, key order and display_name survive a set of the owned keys", () => {
  const out = applyConfigToYaml(SRC, {
    model: "sonnet",
    skills: ["tdd", "release"],
    secrets: ["GH_TOKEN"],
  });
  expect(out).toContain("# The dev template.");
  expect(out).toMatch(/display_name: Dev +# shown in the UI/);
  expect(out).toContain("model: sonnet # pinned");
  expect(out).toContain("custom_key: keep me");
  expect(out.indexOf("name: dev")).toBeLessThan(out.indexOf("runtime"));
  expect(out.indexOf("runtime")).toBeLessThan(out.indexOf("model"));
  expect(out).toMatch(/skills:\n {2}- tdd\n {2}- release\n/);
  expect(out).toMatch(/secrets: \[ ?GH_TOKEN ?\]/);
});

test("an unchanged doc returns the text byte for byte", () => {
  expect(applyConfigToYaml(SRC, { model: "opus", skills: ["tdd"], secrets: ["GH_TOKEN"] })).toBe(
    SRC,
  );
});

test("an owned key absent from the doc is removed, and only that key", () => {
  const out = applyConfigToYaml(SRC, { skills: ["tdd"], secrets: ["GH_TOKEN"] });
  expect(out).not.toContain("model");
  expect(out.replace(/ +# shown/, "   # shown").replace("[ GH_TOKEN ]", "[GH_TOKEN]")).toBe(
    SRC.replace("model: opus # pinned\n", ""),
  );
});

test("keys the form doesn't own are neither written nor removed, whatever the doc says", () => {
  const out = applyConfigToYaml(SRC, {
    model: "opus",
    skills: ["tdd"],
    secrets: ["GH_TOKEN"],
    runtime: "local",
    custom_key: "changed",
    sneaky: 1,
  });
  expect(out).toBe(SRC);
});

test("a new key is appended after the existing ones", () => {
  const out = applyConfigToYaml(SRC, {
    model: "opus",
    skills: ["tdd"],
    secrets: ["GH_TOKEN"],
    effort: "high",
    warm_window_minutes: 30,
  });
  expect(out.endsWith("custom_key: keep me\neffort: high\nwarm_window_minutes: 30\n")).toBe(true);
});

test("an empty file gets a map", () => {
  expect(applyConfigToYaml("", { model: "opus" })).toBe("model: opus\n");
});

test("a list of scalars is updated in place: kept items keep their comments, new ones are appended", () => {
  const src = "name: dev\nskills: # mine\n  - a # first\n  - b # second\n  - c\n";
  const out = applyConfigToYaml(src, { skills: ["a", "c", "d"] });
  expect(out).toBe("name: dev\nskills:\n  # mine\n  - a # first\n  - c\n  - d\n");
});

test("an anchored scalar is replaced, so an alias elsewhere keeps its value", () => {
  const out = applyConfigToYaml("model: &m opus\ndescription: *m\n", { model: "sonnet" });
  expect(parse(out)).toEqual({ model: "sonnet", description: "opus" });
});
