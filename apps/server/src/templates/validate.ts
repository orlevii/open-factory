import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  type TemplateConfig,
  type TemplateFile,
  type TemplateIssue,
  templateYamlSchema,
} from "@open-factory/shared";
import { LOCAL_RUNTIME_DISABLED } from "../config.ts";
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

async function subdirs(p: string) {
  try {
    return (await readdir(p, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export async function validateTemplate(
  dir: string,
  folderName: string,
  ctx: ValidationContext,
  override?: { file: TemplateFile; content: string },
): Promise<{
  config?: TemplateConfig;
  issues: TemplateIssue[];
  tplSettings: Record<string, unknown>;
  tplMcp: { mcpServers: Record<string, unknown> };
}> {
  const issues: TemplateIssue[] = [];
  const add = (i: TemplateIssue) => issues.push(i);
  const err = (file: TemplateIssue["file"], message: string, extra: Partial<TemplateIssue> = {}) =>
    add({ severity: "error", file, message, ...extra });
  const warn = (file: TemplateIssue["file"], message: string, extra: Partial<TemplateIssue> = {}) =>
    add({ severity: "warning", file, message, ...extra });

  let tplSettings: Record<string, unknown> = {};
  let tplMcp: { mcpServers: Record<string, unknown> } = { mcpServers: {} };
  let config: TemplateConfig | undefined;

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
              err("template.yaml", `Unknown field ${key}.`, { line: lineOf(p), path: p.join(".") });
            }
          } else {
            const p = issue.path.map((s) => (typeof s === "symbol" ? String(s) : s));
            err("template.yaml", `${p.join(".")}: ${issue.message}`, {
              line: lineOf(p),
              path: p.join("."),
            });
          }
        }
      } else config = parsed.data;
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
      if (Object.hasOwn(m.value.mcpServers, "factory"))
        err("mcp.json", 'The MCP server name "factory" is reserved.');
    }
  }

  // Semantic rules
  if (config) {
    if (config.name !== folderName)
      err("template.yaml", `name "${config.name}" doesn't match the folder name "${folderName}".`, {
        line: lineOf(["name"]),
        path: "name",
      });

    const localSkills = new Set(await subdirs(path.join(dir, "skills")));
    for (const [i, n] of config.skills.entries()) {
      const at = { line: lineOf(["skills", i]), path: `skills.${i}` };
      if (!(await isDir(path.join(ctx.hostSkillsDir, n))))
        err("template.yaml", `Host skill ${n} is missing from ${ctx.hostSkillsDir}.`, at);
      if (localSkills.has(n))
        err(
          "template.yaml",
          `Host skill ${n} has the same name as a template skill in skills/.`,
          at,
        );
    }
    const image = config.image ? resolveImage(config.image, "") : undefined;
    if (image?.kind === "user" && !ctx.userImages.has(image.name))
      err(
        "template.yaml",
        `No user image \u2018${image.name}\u2019 (images/${image.name}/Dockerfile). For a Docker Hub image, write docker.io/library/${image.name}.`,
        { line: lineOf(["image"]), path: "image" },
      );
    for (const [i, p] of config.projects.entries())
      if (!ctx.projects.has(p))
        err("template.yaml", `Project ${p} isn't registered. Add it in Settings → Projects.`, {
          line: lineOf(["projects", i]),
          path: `projects.${i}`,
        });
    if (config.runtime === "local" && !ctx.localRuntimeAllowed)
      warn("template.yaml", LOCAL_RUNTIME_DISABLED, { path: "runtime" });
    if (config.permissionMode === "bypass" && config.runtime === "local")
      err("template.yaml", "permission_mode: bypass needs runtime: docker.", {
        line: lineOf(["permission_mode"]),
        path: "permission_mode",
      });

    const markets = isObj(tplSettings.extraKnownMarketplaces)
      ? tplSettings.extraKnownMarketplaces
      : {};
    for (const [i, plugin] of config.plugins.entries()) {
      const m = plugin.slice(plugin.indexOf("@") + 1);
      if (!Object.hasOwn(markets, m))
        err(
          "template.yaml",
          `Marketplace ${m} (for plugin ${plugin}) isn't declared in settings.json extraKnownMarketplaces.`,
          { line: lineOf(["plugins", i]), path: `plugins.${i}` },
        );
    }
    for (const [m, def] of Object.entries(markets)) {
      const src = isObj(def) && isObj(def.source) ? def.source : undefined;
      if (!src) continue;
      const t = src.source;
      if (t !== "directory" && t !== "git" && t !== "github")
        err(
          "settings.json",
          `Marketplace ${m}: source type ${String(t)} isn't supported; use directory, git or github.`,
        );
      const hasRef = Object.hasOwn(src, "ref");
      const hasPath = Object.hasOwn(src, "path") && t !== "directory";
      if (hasRef || hasPath)
        err("settings.json", `Marketplace ${m}: ref and path aren't supported.`);
    }

    for (const [i, s] of config.secrets.entries())
      if (!ctx.secrets.has(s))
        warn("template.yaml", `Secret ${s} isn't set. Add it in Settings → Secrets.`, {
          line: lineOf(["secrets", i]),
          path: `secrets.${i}`,
        });
    for (const [i, t] of config.canSpawn.entries())
      if (!ctx.templates.has(t))
        warn("template.yaml", `can_spawn lists ${t}, which isn't a template.`, {
          line: lineOf(["can_spawn", i]),
          path: `can_spawn.${i}`,
        });
  }

  if (isObj(tplSettings.permissions) && tplSettings.permissions.defaultMode !== undefined)
    warn(
      "settings.json",
      "permissions.defaultMode is ignored: the factory sets the permission mode.",
    );
  if (tplSettings.enabledPlugins !== undefined)
    warn("settings.json", "enabledPlugins is ignored: list plugins in template.yaml.");

  for (const entry of await readdir(path.join(dir, "files")).catch(() => [] as string[]))
    if (RESERVED_FILES.includes(entry.toLowerCase()))
      err("files", `files/${entry} would overwrite a file the factory manages.`, {
        path: `files/${entry}`,
      });

  return { ...(config ? { config } : {}), issues, tplSettings, tplMcp };
}
