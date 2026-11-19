import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { type ValidationContext, validateTemplate } from "./validate.ts";

const hostSkills = mkdtempSync(path.join(tmpdir(), "skills-"));
mkdirSync(path.join(hostSkills, "grilling"));
const ctx: ValidationContext = {
  projects: new Set(["app"]),
  secrets: new Set(["GH_TOKEN"]),
  templates: new Set(["tech-lead", "dev"]),
  hostSkillsDir: hostSkills,
};

function tpl(files: Record<string, string>, name = "tech-lead") {
  const root = mkdtempSync(path.join(tmpdir(), "tpl-"));
  const dir = path.join(root, name);
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), c);
  }
  return dir;
}
const base = {
  "template.yaml": "name: tech-lead\ndisplay_name: Tech Lead\nruntime: local\n",
  "AGENTS.md": "# TL\n",
};

test("a clean template", async () => {
  const r = await validateTemplate(tpl(base), "tech-lead", ctx);
  expect(r.issues).toEqual([]);
  expect(r.config?.runtime).toBe("local");
  expect(r.tplSettings).toEqual({});
  expect(r.tplMcp).toEqual({ mcpServers: {} });
});

test.each([
  ["missing AGENTS.md", { "AGENTS.md": null }, /AGENTS\.md is missing/],
  ["yaml syntax", { "template.yaml": "name: [" }, /YAML/],
  ["schema", { "template.yaml": "name: tech-lead\ndisplay_name: X\nmodle: opus\n" }, /modle/],
  [
    "name != folder",
    { "template.yaml": "name: other\ndisplay_name: X\n" },
    /doesn't match the folder/,
  ],
  [
    "unknown host skill",
    { "template.yaml": "name: tech-lead\ndisplay_name: X\nskills: [nope]\n" },
    /Host skill nope/,
  ],
  [
    "host skill vs local skill",
    {
      "template.yaml": "name: tech-lead\ndisplay_name: X\nskills: [grilling]\n",
      "skills/grilling/SKILL.md": "x",
    },
    /same name/,
  ],
  [
    "unknown project",
    { "template.yaml": "name: tech-lead\ndisplay_name: X\nprojects: [web]\n" },
    /Project web isn't registered/,
  ],
  [
    "bypass + local",
    {
      "template.yaml":
        "name: tech-lead\ndisplay_name: X\nruntime: local\npermission_mode: bypass\n",
    },
    /bypass/,
  ],
  [
    "undeclared marketplace",
    { "template.yaml": "name: tech-lead\ndisplay_name: X\nplugins: [p@m]\n" },
    /Marketplace m/,
  ],
  ["mcp without mcpServers", { "mcp.json": "{}" }, /mcpServers/],
  ["reserved mcp server", { "mcp.json": '{"mcpServers":{"factory":{}}}' }, /factory/],
  ["reserved files entry", { "files/CLAUDE.md": "x" }, /files\/CLAUDE\.md/],
  [
    "bad marketplace source",
    {
      "settings.json": '{"extraKnownMarketplaces":{"m":{"source":{"source":"npm","package":"x"}}}}',
      "template.yaml": "name: tech-lead\ndisplay_name: X\nplugins: [p@m]\n",
    },
    /source/,
  ],
  [
    "marketplace ref field",
    {
      "settings.json":
        '{"extraKnownMarketplaces":{"m":{"source":{"source":"github","repo":"o/r","ref":"v1"}}}}',
      "template.yaml": "name: tech-lead\ndisplay_name: X\nplugins: [p@m]\n",
    },
    /ref/,
  ],
])("error: %s", async (_n, files, re) => {
  const dir = tpl(
    Object.fromEntries(
      Object.entries({ ...base, ...files }).filter(([, v]) => v !== null),
    ) as Record<string, string>,
  );
  const issues = (await validateTemplate(dir, "tech-lead", ctx)).issues;
  expect(issues.filter((i) => i.severity === "error").map((i) => i.message)).toContainEqual(
    expect.stringMatching(re),
  );
});

test.each([
  [
    "undefined secret",
    { "template.yaml": "name: tech-lead\ndisplay_name: X\nsecrets: [NPM_TOKEN]\n" },
    /Secret NPM_TOKEN isn't set/,
  ],
  [
    "unknown can_spawn",
    { "template.yaml": "name: tech-lead\ndisplay_name: X\ncan_spawn: [ghost]\n" },
    /ghost/,
  ],
  [
    "defaultMode ignored",
    { "settings.json": '{"permissions":{"defaultMode":"dontAsk"}}' },
    /defaultMode/,
  ],
  [
    "enabledPlugins ignored",
    { "settings.json": '{"enabledPlugins":{"a@b":true}}' },
    /enabledPlugins/,
  ],
])("warning: %s", async (_n, files, re) => {
  const issues = (await validateTemplate(tpl({ ...base, ...files }), "tech-lead", ctx)).issues;
  expect(issues.filter((i) => i.severity === "warning").map((i) => i.message)).toContainEqual(
    expect.stringMatching(re),
  );
  expect(issues.filter((i) => i.severity === "error")).toEqual([]);
});

test("schema issue carries the yaml line; json issue carries line and column", async () => {
  const r = await validateTemplate(
    tpl({ ...base, "template.yaml": "name: tech-lead\ndisplay_name: X\nskills:\n  - ..\n" }),
    "tech-lead",
    ctx,
  );
  expect(r.issues[0]).toMatchObject({ file: "template.yaml", line: 4 });
  const j = await validateTemplate(
    tpl({ ...base, "settings.json": '{\n "a": 1,\n}' }),
    "tech-lead",
    ctx,
  );
  expect(j.issues[0]).toMatchObject({ file: "settings.json", line: 3 });
});

test("override substitutes unsaved content for one file", async () => {
  const dir = tpl(base);
  const r = await validateTemplate(dir, "tech-lead", ctx, {
    file: "template.yaml",
    content: "name: tech-lead\ndisplay_name: X\nprojects: [web]\n",
  });
  expect(r.issues.map((i) => i.message)).toContainEqual(expect.stringMatching(/web/));
});

const plug = "name: tech-lead\ndisplay_name: X\nplugins: [p@m]\n";
const mk = (src: string) => ({
  "template.yaml": plug,
  "settings.json": `{"extraKnownMarketplaces":{"m":{"source":${src}}}}`,
});

test("a directory marketplace with path is valid", async () => {
  const r = await validateTemplate(
    tpl({ ...base, ...mk('{"source":"directory","path":"/x"}') }),
    "tech-lead",
    ctx,
  );
  expect(r.issues).toEqual([]);
});

test.each([
  '{"source":"git","url":"u","ref":"v1"}',
  '{"source":"git","url":"u","path":"p"}',
  '{"source":"github","repo":"o/r","path":"p"}',
  '{"source":"directory","path":"/x","ref":"v1"}',
])("marketplace source %s is rejected", async (src) => {
  const r = await validateTemplate(tpl({ ...base, ...mk(src) }), "tech-lead", ctx);
  expect(r.issues.map((i) => i.message)).toContainEqual(expect.stringMatching(/ref and path/));
});

test.each(["constructor", "toString"])(
  "plugin from inherited name %s has no marketplace",
  async (m) => {
    const r = await validateTemplate(
      tpl({ ...base, "template.yaml": `name: tech-lead\ndisplay_name: X\nplugins: [x@${m}]\n` }),
      "tech-lead",
      ctx,
    );
    expect(r.issues.map((i) => i.message)).toContainEqual(expect.stringMatching(/isn't declared/));
  },
);

test("reserved files entries match case-insensitively", async () => {
  const r = await validateTemplate(tpl({ ...base, "files/claude.md": "x" }), "tech-lead", ctx);
  expect(r.issues.map((i) => i.message)).toContainEqual(expect.stringMatching(/files\/claude\.md/));
});
