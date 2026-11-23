import { lstat, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  type AgentOverlay,
  agentOverlaySchema,
  CONFIG_MSG,
  type ConfigDoc,
  canonicalJson,
  ENV_NAME,
  isFactoryEnvName,
  mergeConfig,
  type TemplateConfig,
  type TemplateFile,
  type TemplateIssue,
  templateYamlSchema,
  yamlPart,
} from "@open-factory/shared";
import { LOCAL_RUNTIME_DISABLED } from "../config.ts";
import { FIELD_MSG } from "../field-messages.ts";
import { resolveImage } from "../images/resolve.ts";
import { parseJson, parseYaml } from "./parse.ts";

export interface ValidationContext {
  projects: Set<string>;
  secrets: Set<string>;
  templates: Set<string>;
  /** Names whose `images/<name>/Dockerfile` exists. */
  userImages: Set<string>;
  hostSkillsDir: string;
  /** `localRuntimeAllowed(config)`: the one gate rule. */
  localRuntimeAllowed: boolean;
}

export interface EffectiveContext extends ValidationContext {
  /** The template folder, for the `skills/` link checks. */
  templateDir?: string;
  /** Runtimes of the template's live and archived agents. */
  agentRuntimes?: ("local" | "docker")[];
}

const RESERVED_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "CLAUDE.local.md",
  ".claude",
  ".claude-config",
  ".mcp.json",
  ".factory",
  "projects",
].map((n) => n.toLowerCase());

async function read(
  dir: string,
  file: TemplateFile,
  override?: { file: TemplateFile; content: string },
) {
  if (override?.file === file) return override.content;
  try {
    return await readFile(path.join(dir, file), "utf8");
  } catch {
    return undefined;
  }
}

async function isDir(p: string) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const segment = (s: string): string | number => (/^\d+$/.test(s) ? Number(s) : s);

const FILE_OF = { template: "template.yaml", settings: "settings.json", mcp: "mcp.json" } as const;
type Root = keyof typeof FILE_OF;

const plainRefs = (v: string): string[] =>
  [...v.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1] as string);

/** Names of the entries of `<dir>/skills`, and the errors for links and non-folders. */
async function localSkillNames(dir: string | undefined, issues: TemplateIssue[]) {
  const names = new Set<string>();
  if (!dir) return names;
  const root = path.join(dir, "skills");
  const link = (message: string) => issues.push({ severity: "error", file: "skills", message });
  const top = await lstat(root).catch(() => undefined);
  if (!top) return names;
  if (!top.isDirectory()) {
    link("skills/ must be a folder, not a link.");
    return names;
  }
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if (name.startsWith(".")) continue;
    const st = await lstat(path.join(root, name)).catch(() => undefined);
    if (st?.isDirectory()) names.add(name);
    else link(`skills/${name} must be a folder, not a link.`);
  }
  return names;
}

/**
 * The semantic rules for any config document: a template's own files, or a template merged with an
 * overlay. Paths are rooted at `template.`, `settings.` or `mcp.`. Messages never carry a value.
 * `policy` is "human" in I2; I7 adds "agent".
 */
export async function validateEffective(
  doc: ConfigDoc,
  ctx: EffectiveContext,
  _policy: "human",
): Promise<TemplateIssue[]> {
  const issues: TemplateIssue[] = [];
  const add = (
    severity: TemplateIssue["severity"],
    root: Root,
    at: (string | number)[],
    message: string,
  ) =>
    issues.push({
      severity,
      file: FILE_OF[root],
      message,
      path: [root, ...at].join("."),
    });

  // The derived `local_skill_names` isn't a template.yaml key (it can't be written there: the file parse refuses it).
  const parsed = templateYamlSchema.safeParse(yamlPart(doc.template));
  if (parsed.success) {
    const config = parsed.data;
    const t = (severity: TemplateIssue["severity"], at: (string | number)[], message: string) =>
      add(severity, "template", at, message);

    const localSkills = await localSkillNames(ctx.templateDir, issues);
    for (const [i, n] of config.skills.entries()) {
      if (!(await isDir(path.join(ctx.hostSkillsDir, n))))
        t("error", ["skills", i], `Host skill ${n} is missing from ${ctx.hostSkillsDir}.`);
      if (localSkills.has(n))
        t(
          "error",
          ["skills", i],
          `Host skill ${n} has the same name as a template skill in skills/.`,
        );
    }
    const image = config.image ? resolveImage(config.image, "") : undefined;
    if (image?.kind === "user" && !ctx.userImages.has(image.name))
      t(
        "error",
        ["image"],
        `No user image \u2018${image.name}\u2019 (images/${image.name}/Dockerfile). For a Docker Hub image, write docker.io/library/${image.name}.`,
      );
    for (const [i, p] of config.projects.entries())
      if (!ctx.projects.has(p))
        t(
          "error",
          ["projects", i],
          `Project ${p} isn't registered. Add it in Settings \u2192 Projects.`,
        );
    if (config.runtime === "local" && !ctx.localRuntimeAllowed)
      t("warning", ["runtime"], LOCAL_RUNTIME_DISABLED);
    if (config.permissionMode === "bypass" && config.runtime === "local")
      t("error", ["permission_mode"], "permission_mode: bypass needs runtime: docker.");
    if (ctx.agentRuntimes?.some((r) => r !== config.runtime))
      t("warning", ["runtime"], "Existing agents keep their runtime.");

    const markets = isObj(doc.settings.extraKnownMarketplaces)
      ? doc.settings.extraKnownMarketplaces
      : {};
    for (const [i, plugin] of config.plugins.entries()) {
      const m = plugin.slice(plugin.indexOf("@") + 1);
      if (!Object.hasOwn(markets, m))
        t("error", ["plugins", i], `Marketplace ${m} isn't declared by template ${config.name}.`);
    }
    // Factory-owned secret names never get here: secretNameSchema rejects them at the parse above.
    for (const [i, s] of config.secrets.entries())
      if (!ctx.secrets.has(s))
        t("warning", ["secrets", i], `Secret ${s} isn't set. Add it in Settings \u2192 Secrets.`);
    for (const [i, name] of config.canSpawn.entries())
      if (!ctx.templates.has(name))
        t("warning", ["can_spawn", i], `can_spawn lists ${name}, which isn't a template.`);
  }

  const s = (message: string, at: (string | number)[], severity: TemplateIssue["severity"]) =>
    add(severity, "settings", at, message);
  for (const [m, def] of Object.entries(
    isObj(doc.settings.extraKnownMarketplaces) ? doc.settings.extraKnownMarketplaces : {},
  )) {
    const src = isObj(def) && isObj(def.source) ? def.source : undefined;
    if (!src) continue;
    const kind = src.source;
    const at = ["extraKnownMarketplaces", m];
    if (kind !== "directory" && kind !== "git" && kind !== "github")
      s(
        `Marketplace ${m}: source type ${String(kind)} isn't supported; use directory, git or github.`,
        at,
        "error",
      );
    if (Object.hasOwn(src, "ref") || (Object.hasOwn(src, "path") && kind !== "directory"))
      s(`Marketplace ${m}: ref and path aren't supported.`, at, "error");
  }
  if (isObj(doc.settings.permissions) && doc.settings.permissions.defaultMode !== undefined)
    s("permissions.defaultMode is set by the factory.", ["permissions", "defaultMode"], "error");
  if (doc.settings.enabledPlugins !== undefined)
    s("enabledPlugins is ignored: list plugins in template.yaml.", ["enabledPlugins"], "warning");
  const env = isObj(doc.settings.env) ? doc.settings.env : {};
  for (const name of Object.keys(env)) {
    // A name that fails the name rule may be a pasted value: never echo it.
    if (!ENV_NAME.test(name)) s(CONFIG_MSG.envName, ["env"], "error");
    else if (isFactoryEnvName(name)) s(FIELD_MSG.factoryEnv(name), ["env", name], "error");
  }

  const servers = doc.mcp.mcpServers;
  if (Object.hasOwn(servers, "factory"))
    add("error", "mcp", ["mcpServers", "factory"], 'The MCP server name "factory" is reserved.');
  const known = new Set<string>([
    ...(Array.isArray(doc.template.secrets) ? (doc.template.secrets as string[]) : []),
    ...Object.keys(env),
  ]);
  for (const [name, server] of Object.entries(servers)) {
    if (!isObj(server)) continue;
    for (const part of ["env", "headers"] as const) {
      const values = server[part];
      if (!isObj(values)) continue;
      for (const [key, v] of Object.entries(values))
        if (typeof v === "string")
          for (const ref of new Set(plainRefs(v)))
            if (!known.has(ref))
              add(
                "warning",
                "mcp",
                ["mcpServers", name, part, key],
                `${ref} isn't a secret or env var here.`,
              );
    }
  }
  return issues;
}

const issueKey = (i: TemplateIssue) => `${i.message}|${i.path ?? ""}`;

/** The value at a dotted path of a document, for rebasing list indices. */
function valueAt(doc: unknown, at: string[]): unknown {
  let v: unknown = doc;
  for (const k of at)
    v = isObj(v) || Array.isArray(v) ? (v as Record<string, unknown>)[k] : undefined;
  return v;
}

/**
 * What saving `overlay` on `base` would report: the overlay schema's own issues, plus the issues the
 * merge adds over the base alone. List paths are rebased from the merged list to the overlay's.
 */
export async function overlayIssues(
  base: ConfigDoc,
  overlay: AgentOverlay,
  ctx: EffectiveContext,
): Promise<TemplateIssue[]> {
  const out: TemplateIssue[] = [];
  const parsed = agentOverlaySchema.safeParse(overlay);
  if (!parsed.success)
    for (const z of parsed.error.issues) {
      // An env name that fails the name rule may be a pasted value: report the env object instead.
      const at = (z.message === CONFIG_MSG.envName ? z.path.slice(0, -1) : z.path).map(String);
      // One issue per path: a reserved secret name trips both the name schema and the factory rule.
      if (out.some((o) => o.path === at.join("."))) continue;
      const root = (at[0] ?? "template") as Root;
      out.push({
        severity: "error",
        file: FILE_OF[root] ?? "template.yaml",
        message: z.message,
        ...(at.length ? { path: at.join(".") } : {}),
      });
    }
  const merged = mergeConfig(base, overlay);
  const before = new Set((await validateEffective(base, ctx, "human")).map(issueKey));
  const reported = new Set(out.map((i) => i.path));
  for (const i of await validateEffective(merged, ctx, "human")) {
    if (before.has(issueKey(i)) || reported.has(i.path)) continue;
    out.push({ ...i, ...(i.path ? { path: rebase(i.path, merged, overlay) } : {}) });
  }
  return out;
}

function rebase(p: string, merged: ConfigDoc, overlay: AgentOverlay): string {
  const at = p.split(".");
  const last = at.at(-1);
  if (last === undefined || !/^\d+$/.test(last)) return p;
  const parent = at.slice(0, -1);
  const mine = valueAt(overlay, parent);
  const item = valueAt(merged, parent);
  if (!Array.isArray(mine) || !Array.isArray(item)) return p;
  const j = mine.findIndex((x) => canonicalJson(x) === canonicalJson(item[Number(last)]));
  return j < 0 ? parent.join(".") : [...parent, j].join(".");
}

export async function validateTemplate(
  dir: string,
  folderName: string,
  ctx: EffectiveContext,
  override?: { file: TemplateFile; content: string },
): Promise<{
  config?: TemplateConfig;
  issues: TemplateIssue[];
  tplYaml: Record<string, unknown>;
  /** I2 §7.2: the real folders under `skills/`, sorted (the doc's derived `local_skill_names`). */
  localSkillNames: string[];
  tplSettings: Record<string, unknown>;
  tplMcp: { mcpServers: Record<string, unknown> };
}> {
  const issues: TemplateIssue[] = [];
  const add = (i: TemplateIssue) => issues.push(i);
  const err = (file: TemplateIssue["file"], message: string, extra: Partial<TemplateIssue> = {}) =>
    add({ severity: "error", file, message, ...extra });

  let tplSettings: Record<string, unknown> = {};
  let tplMcp: { mcpServers: Record<string, unknown> } = { mcpServers: {} };
  let config: TemplateConfig | undefined;
  let tplYaml: Record<string, unknown> = {};

  const yamlText = await read(dir, "template.yaml", override);
  const agentsText = await read(dir, "AGENTS.md", override);
  const settingsText = await read(dir, "settings.json", override);
  const mcpText = await read(dir, "mcp.json", override);

  // template.yaml
  let lineOf: (p: (string | number)[]) => number | undefined = () => undefined;
  if (yamlText === undefined) err("template.yaml", "template.yaml is missing.");
  else {
    const y = parseYaml(yamlText);
    lineOf = y.lineOf;
    if (y.error)
      err("template.yaml", y.error.message, { line: y.error.line, column: y.error.column });
    else {
      const parsed = templateYamlSchema.safeParse(y.value ?? {});
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          if (issue.code === "unrecognized_keys") {
            for (const key of issue.keys) {
              const p = [...issue.path, key].map((s) => (typeof s === "symbol" ? String(s) : s));
              err("template.yaml", `Unknown field ${key}.`, {
                line: lineOf(p),
                path: ["template", ...p].join("."),
              });
            }
          } else {
            const p = issue.path.map((s) => (typeof s === "symbol" ? String(s) : s));
            err("template.yaml", `${p.join(".")}: ${issue.message}`, {
              line: lineOf(p),
              path: ["template", ...p].join("."),
            });
          }
        }
      } else config = parsed.data;
      if (isObj(y.value)) tplYaml = y.value;
    }
  }

  // AGENTS.md
  if (agentsText === undefined) err("AGENTS.md", "AGENTS.md is missing.");

  // settings.json
  if (settingsText !== undefined) {
    const s = parseJson(settingsText);
    if (s.error)
      err("settings.json", s.error.message, { line: s.error.line, column: s.error.column });
    else if (!isObj(s.value)) err("settings.json", "JSON: settings.json must be an object.");
    else tplSettings = s.value;
  }

  // mcp.json
  if (mcpText !== undefined) {
    const m = parseJson(mcpText);
    if (m.error) err("mcp.json", m.error.message, { line: m.error.line, column: m.error.column });
    else if (!isObj(m.value) || !isObj(m.value.mcpServers))
      err("mcp.json", 'mcp.json needs a top-level "mcpServers" object.');
    else {
      tplMcp = { ...m.value, mcpServers: m.value.mcpServers };
    }
  }

  // Semantic rules, shared with overlays (validateEffective).
  if (config && config.name !== folderName)
    err("template.yaml", `name "${config.name}" doesn't match the folder name "${folderName}".`, {
      line: lineOf(["name"]),
      path: "template.name",
    });
  const effective = await validateEffective(
    { template: tplYaml, settings: tplSettings, mcp: tplMcp },
    { ...ctx, templateDir: dir },
    "human",
  );
  for (const i of effective)
    add(
      i.file === "template.yaml" && i.path?.startsWith("template.")
        ? { ...i, line: lineOf(i.path.slice("template.".length).split(".").map(segment)) }
        : i,
    );

  for (const entry of await readdir(path.join(dir, "files")).catch(() => [] as string[]))
    if (RESERVED_FILES.includes(entry.toLowerCase()))
      err("files", `files/${entry} would overwrite a file the factory manages.`, {
        path: `files/${entry}`,
      });

  // Link and non-folder entries are reported by validateEffective above; here only the names.
  const localSkills = [...(await localSkillNames(dir, []))].sort();
  return {
    ...(config ? { config } : {}),
    issues,
    tplYaml,
    tplSettings,
    tplMcp,
    localSkillNames: localSkills,
  };
}
