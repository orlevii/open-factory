/**
 * The factory-owned plugin settings of one start (spec §7.3 steps 2 and 5), and the two bounded reads of the agent's
 * plugins dir that feed them (§7.2): `installed_plugins.json` and the installed manifests. Claude Code writes that
 * dir (and so can the agent), so every read is `lstat`ed, size-capped and kept inside the dir.
 */
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { type Pin, PLUGIN_REF_PATTERN } from "@open-factory/shared";

/** Larger than any real manifest or installed list; a bigger file is ignored, not read. */
const MAX_BYTES = 256 * 1024;
const MAX_INSTALLED = 500;

/** What a plugin's `plugin.json` says that the factory reads: its name, version and dependencies. */
export interface PluginManifest {
  name?: string;
  version?: string;
  /** A dependency's own marketplace when the manifest names one; the dependent's own otherwise. */
  dependencies: { name: string; marketplace?: string }[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The parsed JSON of a regular file of at most 256 KB; undefined for a link, another type, a big or a bad one. */
async function readJsonFile(file: string): Promise<unknown> {
  try {
    const st = await lstat(file);
    if (!st.isFile() || st.size > MAX_BYTES) return undefined;
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

const insideOf = (root: string, p: string): boolean => {
  const rel = path.relative(root, p);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

function dependenciesOf(raw: unknown): PluginManifest["dependencies"] {
  if (!Array.isArray(raw)) return [];
  const out: PluginManifest["dependencies"] = [];
  for (const d of raw) {
    if (typeof d === "string") {
      const at = d.lastIndexOf("@");
      if (at > 0) out.push({ name: d.slice(0, at), marketplace: d.slice(at + 1) });
      else if (d) out.push({ name: d });
    } else if (isRecord(d) && typeof d.name === "string" && d.name) {
      out.push({
        name: d.name,
        ...(typeof d.marketplace === "string" && d.marketplace
          ? { marketplace: d.marketplace }
          : {}),
      });
    }
  }
  return out;
}

/** `<dir>/.claude-plugin/plugin.json`, read with the caps; undefined when it is absent or can't be read. */
export async function readManifest(dir: string): Promise<PluginManifest | undefined> {
  const doc = await readJsonFile(path.join(dir, ".claude-plugin", "plugin.json"));
  if (!isRecord(doc)) return undefined;
  return {
    ...(typeof doc.name === "string" ? { name: doc.name } : {}),
    ...(typeof doc.version === "string" ? { version: doc.version } : {}),
    dependencies: dependenciesOf(doc.dependencies),
  };
}

/** The plugin keys a manifest depends on: a dependency with no marketplace lives in the dependent's own. */
export function dependencyKeys(manifest: PluginManifest, ownMarketplace: string): string[] {
  return manifest.dependencies.map((d) => `${d.name}@${d.marketplace ?? ownMarketplace}`);
}

/**
 * Every plugin the agent's `installed_plugins.json` lists (`{ version: 2, plugins: { "name@mkt": [{ installPath }] } }`),
 * with its manifest when `installPath` resolves, through real folders only, to a location inside `pluginsDir`.
 * A missing, linked, oversized or unreadable list is empty; a key that isn't a plugin ref is dropped.
 */
export async function readInstalled(
  pluginsDir: string,
): Promise<{ key: string; manifest?: PluginManifest }[]> {
  const doc = await readJsonFile(path.join(pluginsDir, "installed_plugins.json"));
  const plugins = isRecord(doc) && isRecord(doc.plugins) ? doc.plugins : {};
  const root = await realpath(pluginsDir).catch(() => undefined);
  const out: { key: string; manifest?: PluginManifest }[] = [];
  for (const [key, entries] of Object.entries(plugins).slice(0, MAX_INSTALLED)) {
    if (!PLUGIN_REF_PATTERN.test(key)) continue;
    const first = Array.isArray(entries) ? entries[0] : undefined;
    const installPath = isRecord(first) ? first.installPath : undefined;
    let manifest: PluginManifest | undefined;
    if (root && typeof installPath === "string" && path.isAbsolute(installPath)) {
      const real = await realpath(installPath).catch(() => undefined);
      if (real && insideOf(root, real)) manifest = await readManifest(real);
    }
    out.push({ key, ...(manifest ? { manifest } : {}) });
  }
  return out;
}

export type MarketplaceSource =
  | { source: "github"; repo: string }
  | { source: "git"; url: string }
  | { source: "directory"; path: string };

export interface PluginSettings {
  enabledPlugins: Record<string, boolean>;
  extraKnownMarketplaces: Record<string, { source: Record<string, unknown>; autoUpdate: boolean }>;
  syncClaudeAiPlugins: false;
}

/**
 * The keys the factory sets on every start, passed as `--settings` (spec §7.3 step 5). Generated, so an explicit
 * `false` is fine here. `declarations` holds only the marketplaces of plugins in `closure`; the template's own
 * declarations are never carried over.
 * - `enabledPlugins`: `true` for the closure; `false` for every other plugin of a declared marketplace's catalog at
 *   its pin (relative-path plugins load by default otherwise), for every installed key outside the closure, and for
 *   each skills-directory plugin name the factory knows of.
 * - `extraKnownMarketplaces`: the registry source, plus `ref` and `autoUpdate: false` when pinned, or no `ref` and
 *   `autoUpdate: true` for Latest. A live directory has neither a `ref` nor auto-update.
 */
export function buildPluginSettings(i: {
  closure: string[];
  declarations: Record<string, { source: MarketplaceSource; pin: Pin }>;
  catalogs: Record<string, string[]>;
  installed: string[];
  skillsDirNames: string[];
}): PluginSettings {
  const enabledPlugins: Record<string, boolean> = {};
  for (const [mkt, names] of Object.entries(i.catalogs))
    for (const name of names) enabledPlugins[`${name}@${mkt}`] = false;
  for (const key of i.installed) enabledPlugins[key] = false;
  for (const name of i.skillsDirNames) enabledPlugins[`${name}@skills-dir`] = false;
  for (const key of i.closure) enabledPlugins[key] = true;
  const extraKnownMarketplaces: PluginSettings["extraKnownMarketplaces"] = {};
  for (const [mkt, { source, pin }] of Object.entries(i.declarations)) {
    const ref = pin.kind === "commit" ? pin.sha : pin.kind === "tag" ? pin.name : undefined;
    extraKnownMarketplaces[mkt] = {
      source: { ...source, ...(ref ? { ref } : {}) },
      autoUpdate: pin.kind === "latest",
    };
  }
  return { enabledPlugins, extraKnownMarketplaces, syncClaudeAiPlugins: false };
}
