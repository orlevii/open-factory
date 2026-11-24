/**
 * What a plugin checkout runs and needs (spec §7.8): its hooks, MCP servers and other code-running parts, the
 * programs they call ("Needs from the image"), what it provides by name, and the parts that couldn't be shown.
 * Everything is read with lstat and never followed out of the root; nothing here runs anything.
 */
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { cutGraphemes, normalizeSubpath } from "@open-factory/shared";
import { isDir, isRecord, SUBJECT_MAX } from "./common.ts";
import { readCapped } from "./skill-files.ts";

/** The paths that hold code a plugin runs. Marketplace digests hash exactly these (marketplaces-service.ts). */
export const CODE_PATHS = [
  "hooks",
  "monitors",
  "bin",
  ".mcp.json",
  ".lsp.json",
  "package.json",
] as const;
/** The `plugin.json` keys whose values run code or may. Marketplace digests hash exactly these. */
export const CODE_KEYS = [
  "hooks",
  "mcpServers",
  "lspServers",
  "statusLine",
  "monitors",
  "dependencies",
] as const;

/** A JSON file is read at most this far (spec §7.8). */
const JSON_CAP = 256 * 1024;
/** The walk lists at most this many regular files (spec §7.8). */
const WALK_CAP = 2000;
const PLUGIN_JSON = ".claude-plugin/plugin.json";
const WALK_STOPPED = "a walk stopped at 2,000 files";
/** Keys `plugin.json` may hold that Open Factory reads or that run nothing. Any other key is listed as unshown. */
const KNOWN_MANIFEST_KEYS = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "dependencies",
  "hooks",
  "mcpServers",
  "lspServers",
  "statusLine",
  "skills",
  "commands",
  "agents",
  "outputStyles",
]);

export type Manifest = {
  name: string | null;
  version: string | null;
  description: string | null;
  author: string | null;
  homepage: string | null;
  repository: string | null;
};

export type HookRow = {
  event: string;
  /** Empty for "All". */
  matcher: string;
  type: string;
  /** The full command for a `command` hook; the URL or prompt for the other types. */
  command: string;
  timeout: number | null;
};

/** An env value is null when it is a `${…}` reference, which is shown by name only. */
export type McpRow = {
  name: string;
  kind: string;
  command: string | null;
  args: string[];
  env: Array<{ name: string; value: string | null }>;
  url: string | null;
  /** Header names only; values are never shown. */
  headers: string[];
};

export type CodePart = {
  kind: "lsp" | "statusLine" | "monitors" | "bin" | "node";
  items: string[];
};

export type Provides = {
  skills: string[];
  commands: string[];
  agents: string[];
  outputStyles: string[];
};

export type ContentsSummary = {
  hooks: number;
  mcp: number;
  codeParts: number;
  dependencies: number;
  skills: number;
  commands: number;
  agents: number;
  outputStyles: number;
  needs: number;
  unshown: number;
};

export type PluginContents = {
  manifest: Manifest;
  hooks: HookRow[];
  mcp: McpRow[];
  dependencies: string[];
  codeParts: CodePart[];
  /** Program names the image must provide, sorted; `bin/` stands for the plugin's executables. */
  needs: string[];
  provides: Provides;
  /** Parts that couldn't be read, each with its reason in parentheses. */
  unshown: string[];
  /** The plugin's own files that hook and MCP commands reference, relative to the root. */
  files: string[];
  summary: ContentsSummary;
};

export type Change<T> = { added: T[]; removed: T[] };

export type ContentsDiff = {
  hooks: Change<HookRow>;
  mcp: Change<McpRow>;
  commands: Change<string>;
  dependencies: Change<string>;
  codeParts: Change<CodePart>;
  needs: Change<string>;
  /** True when a hook, an MCP server or a code part was added or removed. */
  runsCode: boolean;
};

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const cut = (s: string) => cutGraphemes(s, SUBJECT_MAX);
const sources = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const uniqueSorted = (xs: string[]): string[] => [...new Set(xs)].sort();
const dedupe = <T>(xs: T[]): T[] => [...new Map(xs.map((x) => [JSON.stringify(x), x])).values()];

/** `${CLAUDE_PLUGIN_ROOT}/…` in a command: the plugin's own file, not a program. */
const REFERENCE = /^\$\{[^{}]*\}$/;
const ROOT_REFERENCE = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^\s"'`;&|<>()]+)/g;

// Reading -----------------------------------------------------------------------------------

type Resolved =
  | { kind: "absent" }
  | { kind: "link" }
  | { kind: "notFile" }
  | { kind: "file"; abs: string };

/** `rel` (a clean `/` path) under `root`, checked with lstat at every step: a link or a non-file is reported, never followed. */
async function resolveIn(root: string, rel: string): Promise<Resolved> {
  const parts = rel.split("/");
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i] as string);
    const st = await lstat(cur).catch(() => undefined);
    if (!st) return { kind: "absent" };
    if (st.isSymbolicLink()) return { kind: "link" };
    const last = i === parts.length - 1;
    if (!last && !st.isDirectory()) return { kind: "absent" };
    if (last && !st.isFile()) return { kind: "notFile" };
  }
  return { kind: "file", abs: cur };
}

const reasonOf = (r: Resolved) => (r.kind === "link" ? "a link" : "not a file");

/** A JSON object or array at `rel`; absent is undefined, and what can't be read goes to `unshown`. */
async function readJson(root: string, rel: string, unshown: Set<string>): Promise<unknown> {
  const r = await resolveIn(root, rel);
  if (r.kind === "absent") return undefined;
  if (r.kind !== "file") {
    unshown.add(`${rel} (${reasonOf(r)})`);
    return undefined;
  }
  const buf = await readCapped(r.abs, JSON_CAP);
  if (!buf) {
    unshown.add(`${rel} (can't be read)`);
    return undefined;
  }
  if (buf.length > JSON_CAP) {
    unshown.add(`${rel} (over 256 KB)`);
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buf));
  } catch {
    unshown.add(`${rel} (not valid JSON)`);
    return undefined;
  }
  if (typeof value !== "object" || value === null) {
    unshown.add(`${rel} (not valid JSON)`);
    return undefined;
  }
  return value;
}

/** A path a manifest declares, read from the plugin only: absolute paths and `..` are refused. */
async function readDeclared(
  root: string,
  declared: string,
  unshown: Set<string>,
): Promise<unknown> {
  const rel = normalizeSubpath(declared.startsWith("./") ? declared.slice(2) : declared);
  if (!rel) {
    unshown.add(`${cut(declared)} (outside the plugin)`);
    return undefined;
  }
  return readJson(root, rel, unshown);
}

/** The object a config file holds under `key` (`{ "hooks": {…} }`), or the file itself when it has none. */
const unwrap = (obj: Record<string, unknown>, key: string): Record<string, unknown> =>
  isRecord(obj[key]) ? (obj[key] as Record<string, unknown>) : obj;

/** The objects a default config file holds: its file contents, unwrapped, when the file exists. */
async function fileObjects(
  root: string,
  rel: string,
  key: string,
  unshown: Set<string>,
): Promise<Record<string, unknown>[]> {
  const v = await readJson(root, rel, unshown);
  return isRecord(v) ? [unwrap(v, key)] : [];
}

/**
 * The objects a manifest field holds: each declared path is read and unwrapped, each inline object is used as it
 * is (an inline hooks object is the event map itself).
 */
async function sourceObjects(
  root: string,
  value: unknown,
  key: string,
  unshown: Set<string>,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const src of sources(value)) {
    if (typeof src === "string") {
      const v = await readDeclared(root, src, unshown);
      if (isRecord(v)) out.push(unwrap(v, key));
    } else if (isRecord(src)) out.push(src);
  }
  return out;
}

type FileEntry = { path: string; executable: boolean };

/** Regular files under `root`, `.git` left out, links never followed; `capped` when more than the cap exist. */
async function walkFiles(root: string): Promise<{ files: FileEntry[]; capped: boolean }> {
  const files: FileEntry[] = [];
  let capped = false;
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (capped) return;
      if (e.name.toLowerCase() === ".git") continue;
      const abs = path.join(dir, e.name);
      const r = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) await walk(abs, r);
      else if (e.isFile()) {
        const st = await lstat(abs).catch(() => undefined);
        if (!st?.isFile()) continue;
        if (files.length >= WALK_CAP) {
          capped = true;
          return;
        }
        files.push({ path: r, executable: (st.mode & 0o111) !== 0 });
      }
    }
  };
  await walk(root, "");
  return { files, capped };
}

// Hooks, servers and needs ---------------------------------------------------------------------

function hookRows(events: Record<string, unknown>): HookRow[] {
  const rows: HookRow[] = [];
  for (const [event, groups] of Object.entries(events)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
      const matcher = str(group.matcher) ?? "";
      for (const h of group.hooks) {
        if (!isRecord(h)) continue;
        rows.push({
          event,
          matcher,
          type: str(h.type) ?? "command",
          command: str(h.command) ?? str(h.url) ?? str(h.prompt) ?? "",
          timeout: typeof h.timeout === "number" ? h.timeout : null,
        });
      }
    }
  }
  return rows;
}

function envRows(env: unknown): McpRow["env"] {
  if (!isRecord(env)) return [];
  return Object.entries(env).map(([name, value]) => ({
    name,
    value: typeof value === "string" && !REFERENCE.test(value) ? value : null,
  }));
}

function mcpRows(servers: Record<string, unknown>): McpRow[] {
  const rows: McpRow[] = [];
  for (const [name, def] of Object.entries(servers)) {
    if (!isRecord(def)) continue;
    const command = str(def.command) ?? null;
    const url = str(def.url) ?? null;
    rows.push({
      name,
      kind: str(def.type) ?? (command !== null ? "stdio" : url !== null ? "http" : "unknown"),
      command,
      args: strings(def.args),
      env: envRows(def.env),
      url,
      headers: isRecord(def.headers) ? Object.keys(def.headers) : [],
    });
  }
  return rows;
}

/** The programs a shell command line runs: the first word of each command position, past `NAME=value`, not a builtin. */
const PROGRAM = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SEPARATORS = new Set(["&&", "||", ";", "|", "&"]);
const BUILTINS = new Set([
  ".",
  "[",
  "cd",
  "echo",
  "eval",
  "exec",
  "exit",
  "export",
  "false",
  "printf",
  "read",
  "return",
  "set",
  "shift",
  "source",
  "test",
  "trap",
  "true",
  "unset",
  "wait",
]);

/** Splits a command line into words; quotes group, and separators come out as words of their own. */
function shellWords(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: string | null = null;
  const end = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quote) {
      if (c === quote) quote = null;
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === "\\" && i + 1 < text.length) {
      word += text[++i];
      inWord = true;
    } else if (c === "\n") {
      end();
      words.push(";");
    } else if (/\s/.test(c)) {
      end();
    } else if (c === "&" || c === "|" || c === ";") {
      end();
      const op = c !== ";" && text[i + 1] === c ? `${c}${c}` : c;
      if (op.length === 2) i++;
      words.push(op);
    } else {
      word += c;
      inWord = true;
    }
  }
  end();
  return words;
}

function programsOf(command: string, depth = 0): string[] {
  const words = shellWords(command);
  const out: string[] = [];
  let atStart = true;
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string;
    if (SEPARATORS.has(w)) {
      atStart = true;
      continue;
    }
    if (!atStart || ASSIGNMENT.test(w)) continue;
    atStart = false;
    if (
      depth < 2 &&
      (w === "bash" || w === "sh") &&
      words[i + 1] === "-c" &&
      i + 2 < words.length
    ) {
      out.push(...programsOf(words[i + 2] as string, depth + 1));
      i += 2;
      continue;
    }
    if (!BUILTINS.has(w) && PROGRAM.test(w)) out.push(w);
  }
  return out;
}

/** The plugin's own files that `commands` reference as `${CLAUDE_PLUGIN_ROOT}/<rel>`, when they are regular files. */
async function referencedFiles(root: string, commands: string[]): Promise<string[]> {
  const rels = new Set<string>();
  for (const text of commands)
    for (const m of text.matchAll(ROOT_REFERENCE)) {
      const rel = normalizeSubpath(m[1] as string);
      if (rel) rels.add(rel);
    }
  const out: string[] = [];
  for (const rel of uniqueSorted([...rels])) {
    if ((await resolveIn(root, rel)).kind === "file") out.push(rel);
  }
  return out;
}

// Contents -----------------------------------------------------------------------------------

async function buildContents(root: string): Promise<PluginContents> {
  if (!(await isDir(root))) throw new Error("plugin root is not a directory");
  const unshown = new Set<string>();

  const pj = await readJson(root, PLUGIN_JSON, unshown);
  const m: Record<string, unknown> = isRecord(pj) ? pj : {};
  for (const key of Object.keys(m))
    if (!KNOWN_MANIFEST_KEYS.has(key)) unshown.add(`plugin.json key "${cut(key)}"`);

  const text = (v: unknown) => (typeof v === "string" ? cut(v) : null);
  const manifest: Manifest = {
    name: text(m.name),
    version: text(m.version),
    description: text(m.description),
    author: text(isRecord(m.author) ? m.author.name : m.author),
    homepage: text(m.homepage),
    repository: text(isRecord(m.repository) ? m.repository.url : m.repository),
  };
  const dependencies = Array.isArray(m.dependencies)
    ? m.dependencies.flatMap((d): string[] => {
        if (typeof d === "string") return [cut(d)];
        if (isRecord(d) && typeof d.name === "string")
          return [cut(typeof d.version === "string" ? `${d.name}@${d.version}` : d.name)];
        return [];
      })
    : [];

  const hooks = dedupe(
    [
      ...(await fileObjects(root, "hooks/hooks.json", "hooks", unshown)),
      ...(await sourceObjects(root, m.hooks, "hooks", unshown)),
    ].flatMap(hookRows),
  );
  const mcp = dedupe(
    [
      ...(await fileObjects(root, ".mcp.json", "mcpServers", unshown)),
      ...(await sourceObjects(root, m.mcpServers, "mcpServers", unshown)),
    ].flatMap(mcpRows),
  );
  const lsp = dedupe(
    (
      await Promise.all([
        fileObjects(root, ".lsp.json", "lspServers", unshown),
        sourceObjects(root, m.lspServers, "lspServers", unshown),
      ])
    )
      .flat()
      .flatMap((servers) =>
        Object.entries(servers).flatMap(([name, def]) =>
          isRecord(def) && typeof def.command === "string"
            ? [{ name, command: def.command, args: strings(def.args) }]
            : [],
        ),
      ),
  );

  const codeParts: CodePart[] = [];
  const commands: string[] = []; // command lines the image must run

  if (lsp.length > 0) {
    codeParts.push({
      kind: "lsp",
      items: lsp.map((s) => `${s.name}: ${[s.command, ...s.args].join(" ")}`),
    });
    commands.push(...lsp.map((s) => s.command));
  }

  const statusLine =
    str(m.statusLine) ?? (isRecord(m.statusLine) ? str(m.statusLine.command) : undefined);
  if (statusLine !== undefined) {
    codeParts.push({ kind: "statusLine", items: [statusLine] });
    commands.push(statusLine);
  }

  const monitorsFile = await readJson(root, "monitors/monitors.json", unshown);
  const monitorList = Array.isArray(monitorsFile)
    ? monitorsFile
    : isRecord(monitorsFile) && Array.isArray(monitorsFile.monitors)
      ? monitorsFile.monitors
      : [];
  const monitorItems = monitorList.map((e) =>
    isRecord(e) ? (str(e.command) ?? str(e.name) ?? "(unnamed)") : (str(e) ?? "(unnamed)"),
  );
  if (monitorItems.length > 0) codeParts.push({ kind: "monitors", items: monitorItems });

  const walk = await walkFiles(root);
  if (walk.capped) unshown.add(WALK_STOPPED);
  const binFiles = walk.files.filter(
    (f) => f.executable && f.path.startsWith("bin/") && f.path.split("/").length <= 3,
  );
  const bin = await resolveIn(root, "bin");
  if (bin.kind === "link") unshown.add("bin (a link)");
  if (binFiles.length > 0) codeParts.push({ kind: "bin", items: binFiles.map((f) => f.path) });

  const pkg = await resolveIn(root, "package.json");
  if (pkg.kind === "file") codeParts.push({ kind: "node", items: ["package.json"] });
  else if (pkg.kind !== "absent") unshown.add(`package.json (${reasonOf(pkg)})`);

  const hookCommands = hooks.filter((h) => h.type === "command").map((h) => h.command);
  const mcpCommands = mcp.flatMap((s) => (s.command !== null ? [s.command] : []));
  commands.push(...hookCommands, ...mcpCommands);

  const needs = uniqueSorted([
    ...commands.flatMap((c) => programsOf(c)),
    ...(pkg.kind === "file" ? ["node"] : []),
    ...(binFiles.length > 0 ? ["bin/"] : []),
  ]);

  const files = await referencedFiles(root, [
    ...hookCommands,
    ...mcp.flatMap((s) => [s.command ?? "", ...s.args]),
  ]);

  const named = (dir: string, ext: string) =>
    walk.files
      .filter((f) => f.path.startsWith(`${dir}/`) && f.path.endsWith(ext))
      .map((f) => f.path.slice(dir.length + 1, -ext.length));
  const declared = (key: string) =>
    sources(m[key])
      .filter((x): x is string => typeof x === "string")
      .map(cut);
  const provides: Provides = {
    skills: uniqueSorted([
      ...walk.files
        .map((f) => f.path.split("/"))
        .filter((p) => p.length === 3 && p[0] === "skills" && p[2] === "SKILL.md")
        .map((p) => p[1] as string),
      ...declared("skills"),
    ]),
    commands: uniqueSorted([...named("commands", ".md"), ...declared("commands")]),
    agents: uniqueSorted([...named("agents", ".md"), ...declared("agents")]),
    outputStyles: uniqueSorted([...named("output-styles", ".md"), ...declared("outputStyles")]),
  };

  return {
    manifest,
    hooks,
    mcp,
    dependencies,
    codeParts,
    needs,
    provides,
    unshown: [...unshown],
    files,
    summary: {
      hooks: hooks.length,
      mcp: mcp.length,
      codeParts: codeParts.length,
      dependencies: dependencies.length,
      skills: provides.skills.length,
      commands: provides.commands.length,
      agents: provides.agents.length,
      outputStyles: provides.outputStyles.length,
      needs: needs.length,
      unshown: unshown.size,
    },
  };
}

/** Contents by checkout path; a checkout is immutable per commit, so the entry never goes stale. */
const cache = new Map<string, Promise<PluginContents>>();
const CACHE_MAX = 200;

export function readContents(root: string): Promise<PluginContents> {
  const hit = cache.get(root);
  if (hit) return hit;
  const pending = buildContents(root);
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(root, pending);
  pending.catch(() => cache.delete(root));
  return pending;
}

// Diffs --------------------------------------------------------------------------------------

function changed<T>(before: T[], after: T[], key: (t: T) => string): Change<T> {
  const a = new Map(before.map((t) => [key(t), t]));
  const b = new Map(after.map((t) => [key(t), t]));
  return {
    added: [...b].filter(([k]) => !a.has(k)).map(([, t]) => t),
    removed: [...a].filter(([k]) => !b.has(k)).map(([, t]) => t),
  };
}

const json = (t: unknown) => JSON.stringify(t);
const same = (t: string) => t;

/** What changed between two readings of a plugin (spec §7.5). */
export function diffContents(a: PluginContents, b: PluginContents): ContentsDiff {
  const hooks = changed(a.hooks, b.hooks, json);
  const mcp = changed(a.mcp, b.mcp, json);
  const codeParts = changed(a.codeParts, b.codeParts, json);
  return {
    hooks,
    mcp,
    commands: changed(a.provides.commands, b.provides.commands, same),
    dependencies: changed(a.dependencies, b.dependencies, same),
    codeParts,
    needs: changed(a.needs, b.needs, same),
    runsCode: [hooks, mcp, codeParts].some((c) => c.added.length > 0 || c.removed.length > 0),
  };
}
