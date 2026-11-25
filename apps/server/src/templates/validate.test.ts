// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MCP files reference secrets as ${NAME}.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { emptyDoc } from "@open-factory/shared";
import { expect, test } from "vitest";
import { hostOnlyLibrary, writeHostSkill } from "../test/library.ts";
import {
  overlayIssues,
  overlaySchemaIssues,
  type ValidationContext,
  validateEffective,
  validateTemplate,
} from "./validate.ts";

const claude = mkdtempSync(path.join(tmpdir(), "claude-"));
writeHostSkill(claude, "grilling");
// A host skill whose SKILL.md names another skill, so the Library calls it unusable.
mkdirSync(path.join(claude, "skills", "renamed"));
writeFileSync(path.join(claude, "skills", "renamed", "SKILL.md"), "---\nname: other\n---\n");
const ctx: ValidationContext = {
  projects: new Set(["app"]),
  secrets: new Set(["GH_TOKEN"]),
  templates: new Set(["tech-lead", "dev"]),
  userImages: new Set(["smoke"]),
  library: hostOnlyLibrary(claude, claude),
  localRuntimeAllowed: true,
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
    "model that looks like a flag",
    {
      "template.yaml": "name: tech-lead\ndisplay_name: X\nmodel: --dangerously-skip-permissions\n",
    },
    /Can't start with a dash\./,
  ],
  [
    "name != folder",
    { "template.yaml": "name: other\ndisplay_name: X\n" },
    /doesn't match the folder/,
  ],
  [
    "a skill that hasn't been added",
    { "template.yaml": "name: tech-lead\ndisplay_name: X\nskills: [nope]\n" },
    /^Skill nope hasn't been added in Skills\.$/,
  ],
  [
    "an unusable skill",
    { "template.yaml": "name: tech-lead\ndisplay_name: X\nskills: [renamed]\n" },
    /^Skill renamed is unusable: SKILL\.md names it other\.$/,
  ],
  [
    "a Library skill vs a template skill",
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
  [
    "factory env in settings",
    { "settings.json": '{"env":{"ANTHROPIC_API_KEY":"x"}}' },
    /^ANTHROPIC_API_KEY is set by the factory\.$/,
  ],
  [
    "factory env in secrets",
    { "template.yaml": "name: tech-lead\ndisplay_name: X\nsecrets: [OPEN_FACTORY_X]\n" },
    /reserved/,
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
    "unresolved MCP reference",
    { "mcp.json": '{"mcpServers":{"gh":{"url":"u","headers":{"A":"Bearer ${NOPE}"}}}}' },
    /^NOPE isn't a secret or env var here\.$/,
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
    "template.yaml": "name: tech-lead\ndisplay_name: X\nprojects: [web]\n",
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

test("gate off: validator warns on runtime: local", async () => {
  const r = await validateTemplate(tpl(base), "tech-lead", { ...ctx, localRuntimeAllowed: false });
  expect(r.issues).toEqual([
    {
      severity: "warning",
      file: "template.yaml",
      message: "The local runtime is disabled on this factory.",
      line: 3,
      path: "template.runtime",
    },
  ]);
  const docker = tpl({
    ...base,
    "template.yaml": "name: tech-lead\ndisplay_name: Tech Lead\nruntime: docker\n",
  });
  expect(
    (await validateTemplate(docker, "tech-lead", { ...ctx, localRuntimeAllowed: false })).issues,
  ).toEqual([]);
});

test("a bare image name without images/<name>/Dockerfile is an error naming the escape", async () => {
  const yaml = "name: tech-lead\ndisplay_name: Tech Lead\nruntime: docker\nimage: ubuntu\n";
  const r = await validateTemplate(tpl({ ...base, "template.yaml": yaml }), "tech-lead", ctx);
  expect(r.issues).toEqual([
    {
      severity: "error",
      file: "template.yaml",
      message:
        "No user image \u2018ubuntu\u2019 (images/ubuntu/Dockerfile). For a Docker Hub image, write docker.io/library/ubuntu.",
      line: 4,
      path: "template.image",
    },
  ]);
});

test("a bare image name with its Dockerfile, and a registry reference, are fine", async () => {
  for (const image of ["smoke", "docker.io/library/ubuntu"]) {
    const yaml = `name: tech-lead\ndisplay_name: Tech Lead\nruntime: docker\nimage: ${image}\n`;
    const r = await validateTemplate(tpl({ ...base, "template.yaml": yaml }), "tech-lead", ctx);
    expect(r.issues).toEqual([]);
  }
});

test("a settings.json defaultMode is an error", async () => {
  const r = await validateTemplate(
    tpl({ ...base, "settings.json": '{"permissions":{"defaultMode":"dontAsk"}}' }),
    "tech-lead",
    ctx,
  );
  expect(r.issues).toEqual([
    expect.objectContaining({ severity: "error", path: "settings.permissions.defaultMode" }),
  ]);
});

test("an MCP reference to a secret or env var raises nothing", async () => {
  const files = {
    ...base,
    "template.yaml": "name: tech-lead\ndisplay_name: X\nsecrets: [GH_TOKEN]\n",
    "settings.json": '{"env":{"REGION":"eu"}}',
    "mcp.json":
      '{"mcpServers":{"gh":{"url":"u","headers":{"A":"Bearer ${GH_TOKEN}"},"env":{"R":"${REGION}"}}}}',
  };
  expect((await validateTemplate(tpl(files), "tech-lead", ctx)).issues).toEqual([]);
});

test("validateTemplate returns the parsed template.yaml object", async () => {
  const r = await validateTemplate(tpl(base), "tech-lead", ctx);
  expect(r.tplYaml).toEqual({ name: "tech-lead", display_name: "Tech Lead", runtime: "local" });
});

test("a symlinked skill folder is an error", async () => {
  const dir = tpl(base);
  const target = mkdtempSync(path.join(tmpdir(), "elsewhere-"));
  mkdirSync(path.join(dir, "skills"));
  symlinkSync(target, path.join(dir, "skills", "x"));
  const r = await validateTemplate(dir, "tech-lead", ctx);
  expect(r.issues).toEqual([
    expect.objectContaining({
      severity: "error",
      file: "skills",
      message: "skills/x must be a folder, not a link.",
    }),
  ]);
});

test("a symlinked skills folder is an error", async () => {
  const dir = tpl(base);
  symlinkSync(mkdtempSync(path.join(tmpdir(), "elsewhere-")), path.join(dir, "skills"));
  const r = await validateTemplate(dir, "tech-lead", ctx);
  expect(r.issues).toEqual([
    expect.objectContaining({
      severity: "error",
      file: "skills",
      message: "skills/ must be a folder, not a link.",
    }),
  ]);
});

test("real skill folders and dotfiles in skills/ are fine", async () => {
  const dir = tpl({ ...base, "skills/a/SKILL.md": "x", "skills/.DS_Store": "x" });
  expect((await validateTemplate(dir, "tech-lead", ctx)).issues).toEqual([]);
});

test("I2 §7.2: the real skill folders come back sorted, as the doc's local_skill_names", async () => {
  const dir = tpl({ ...base, "skills/zeta/SKILL.md": "x", "skills/alpha/SKILL.md": "x" });
  expect((await validateTemplate(dir, "tech-lead", ctx)).localSkillNames).toEqual([
    "alpha",
    "zeta",
  ]);
  expect((await validateTemplate(tpl(base), "tech-lead", ctx)).localSkillNames).toEqual([]);
});

test("local_skill_names is derived only: template.yaml can't set it, validateEffective accepts it in a doc", async () => {
  const r = await validateTemplate(
    tpl({ ...base, "template.yaml": `${base["template.yaml"]}local_skill_names: [x]\n` }),
    "tech-lead",
    ctx,
  );
  expect(r.issues.some((i) => i.severity === "error")).toBe(true);
  const ok = await validateTemplate(tpl(base), "tech-lead", ctx);
  // The semantic rules still run on a doc carrying the key (a strict parse failure would skip them silently).
  const doc = {
    template: { ...ok.tplYaml, skills: ["nope"], local_skill_names: ["x"] },
    settings: ok.tplSettings,
    mcp: ok.tplMcp,
  };
  expect(await validateEffective(doc, ctx, "human")).toEqual([
    expect.objectContaining({ severity: "error", path: "template.skills.0" }),
  ]);
});

test("a runtime that differs from an existing agent's warns", async () => {
  const r = await validateTemplate(tpl(base), "tech-lead", { ...ctx, agentRuntimes: ["docker"] });
  expect(r.issues).toEqual([
    expect.objectContaining({
      severity: "warning",
      message: "Existing agents keep their runtime.",
      path: "template.runtime",
    }),
  ]);
  expect(
    (await validateTemplate(tpl(base), "tech-lead", { ...ctx, agentRuntimes: ["local"] })).issues,
  ).toEqual([]);
});

const baseDoc = () => ({
  ...emptyDoc(),
  template: { name: "dev", display_name: "Dev", runtime: "local" },
});

test("validateEffective roots paths at template., settings. and mcp.", () => {
  const doc = {
    template: { name: "dev", display_name: "Dev", projects: ["nope"] },
    settings: { permissions: { defaultMode: "x" } },
    mcp: { mcpServers: { factory: {} } },
  };
  return validateEffective(doc, ctx, "human").then((issues) => {
    expect(issues.map((i) => i.path).sort()).toEqual([
      "mcp.mcpServers.factory",
      "settings.permissions.defaultMode",
      "template.projects.0",
    ]);
  });
});

test("an overlay plugin whose marketplace the template doesn't declare", async () => {
  const issues = await overlayIssues(baseDoc(), { template: { plugins: ["p@acme"] } }, ctx);
  expect(issues).toEqual([
    expect.objectContaining({
      severity: "error",
      message: "Marketplace acme isn't declared by template dev.",
      path: "template.plugins.0",
    }),
  ]);
});

test("overlayIssues rebases a list index to the overlay", async () => {
  const base = {
    ...baseDoc(),
    template: { name: "dev", display_name: "Dev", skills: [] },
  };
  const issues = await overlayIssues(base, { template: { skills: ["nope"] } }, ctx);
  expect(issues.map((i) => i.path)).toEqual(["template.skills.0"]);
});

test("a skill the Library lists but can't find in its folder is missing, whatever the reason", async () => {
  const library = {
    resolveSkill: async (name: string) =>
      name === "gone"
        ? { ok: false as const, reason: "missing" as const, detail: "Fetch again" }
        : { ok: false as const, reason: "not_added" as const },
  };
  const doc = { ...baseDoc(), template: { name: "dev", display_name: "Dev", skills: ["gone"] } };
  const issues = await validateEffective(doc, { ...ctx, library }, "human");
  expect(issues.map((i) => [i.path, i.message])).toEqual([
    ["template.skills.0", "Skill gone is missing from its folder."],
  ]);
});

test("a template skill with a Library skill's name is a collision in an overlay, and only that", async () => {
  const dir = tpl({ ...base, "skills/grilling/SKILL.md": "x", "skills/mine/SKILL.md": "x" });
  const issues = await overlayIssues(
    { ...baseDoc(), template: { name: "dev", display_name: "Dev", skills: [] } },
    { template: { skills: ["grilling", "mine", "nope"] } },
    { ...ctx, templateDir: dir },
  );
  expect(issues.map((i) => [i.path, i.message])).toEqual([
    ["template.skills.0", "Skill grilling has the same name as a template skill in skills/."],
    ["template.skills.1", "Skill mine has the same name as a template skill in skills/."],
    ["template.skills.2", "Skill nope hasn't been added in Skills."],
  ]);
});

test("overlayIssues reports nothing that already fails on the base", async () => {
  const base = { ...baseDoc(), template: { ...baseDoc().template, projects: ["nope"] } };
  expect(await overlayIssues(base, { template: { model: "opus" } }, ctx)).toEqual([]);
});

test("overlayIssues includes the overlay schema's issues", async () => {
  const issues = await overlayIssues(baseDoc(), { settings: { extraKnownMarketplaces: {} } }, ctx);
  expect(issues).toContainEqual(
    expect.objectContaining({ severity: "error", path: "settings.extraKnownMarketplaces" }),
  );
});

test("overlayIssues never echoes secret-shaped values", async () => {
  const secret = "sk-ant-SECRET0123456789";
  const overlay = {
    template: { [secret]: 1 },
    settings: { env: { [secret]: secret, ANTHROPIC_API_KEY: secret } },
    mcp: {
      mcpServers: {
        gh: {
          command: secret,
          args: [secret],
          url: `https://${secret}.example`,
          env: { T: `${secret}-${"${MISSING}"}` },
          headers: { Authorization: `Bearer ${secret}`, B: "${NOPE}" },
        },
      },
    },
  } as never;
  const issues = await overlayIssues(baseDoc(), overlay, ctx);
  expect(issues.length).toBeGreaterThan(0);
  expect(JSON.stringify(issues)).not.toContain(secret);
});

test("overlaySchemaIssues carries paths and constant messages, never a value or an unknown key", () => {
  const secret = "sk-ant-SECRET0123456789";
  const overlays: Record<string, unknown> = {
    "unknown top key": { [secret]: 1 },
    "unknown template key": { template: { [secret]: 1 } },
    "bad model": { template: { model: `${secret}!` } },
    "bad effort": { template: { effort: secret } },
    "bad secrets": { template: { secrets: [secret, "OPEN_FACTORY_X"] } },
    "long item": { template: { skills: [`${secret}${"a".repeat(1001)}`] } },
    "bad env name": { settings: { env: { [secret]: secret, ANTHROPIC_API_KEY: secret } } },
    "default mode": { settings: { permissions: { defaultMode: secret } } },
    marketplaces: { settings: { extraKnownMarketplaces: { [secret]: secret } } },
    "reserved server": { mcp: { mcpServers: { factory: { command: secret, args: [secret] } } } },
    "unknown mcp key": { mcp: { [secret]: 1 } },
  };
  for (const [name, overlay] of Object.entries(overlays)) {
    const issues = overlaySchemaIssues(overlay);
    expect(issues.length, name).toBeGreaterThan(0);
    expect(JSON.stringify(issues), name).not.toContain(secret);
    expect(
      issues.every((i) => i.severity === "error"),
      name,
    ).toBe(true);
  }
});

test("overlaySchemaIssues is empty for a good overlay", () => {
  expect(overlaySchemaIssues({ template: { model: "opus" } })).toEqual([]);
  expect(overlaySchemaIssues({})).toEqual([]);
});

test("validateEffective never echoes an env name that fails the name rule", async () => {
  const bad = "OPEN_FACTORY_sk-ant-SECRET0123";
  const issues = await validateEffective(
    { ...baseDoc(), settings: { env: { [bad]: "v" } } },
    ctx,
    "human",
  );
  expect(issues).toEqual([expect.objectContaining({ severity: "error", path: "settings.env" })]);
  expect(JSON.stringify(issues)).not.toContain("sk-ant");
});

test("an overlay secret the factory owns gives one issue", async () => {
  const issues = await overlayIssues(baseDoc(), { template: { secrets: ["OPEN_FACTORY_X"] } }, ctx);
  expect(issues.filter((i) => i.path === "template.secrets.0")).toHaveLength(1);
});

test("schema and name issues are rooted like the semantic ones", async () => {
  const r = await validateTemplate(
    tpl({ ...base, "template.yaml": "name: other\ndisplay_name: X\n" }),
    "tech-lead",
    ctx,
  );
  expect(r.issues.map((i) => i.path)).toEqual(["template.name"]);
  const z = await validateTemplate(
    tpl({ ...base, "template.yaml": "name: tech-lead\ndisplay_name: X\nmodle: o\n" }),
    "tech-lead",
    ctx,
  );
  expect(z.issues[0]?.path).toBe("template.modle");
});
