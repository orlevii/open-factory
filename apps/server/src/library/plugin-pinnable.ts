/**
 * Whether a pin holds a plugin's dependencies (spec §7.4): every dependency, transitively and inside the plugin's own
 * marketplace catalog, must itself be held (a relative path, or an external source with a `sha`) and name no version
 * range. Reads checkouts only.
 */
import type { CatalogEntry } from "./marketplaces-service.ts";
import {
  dependencyKeys,
  hasRangedDependency,
  type PluginManifest,
  readManifestUnder,
} from "./plugin-settings.ts";
import { classifyPluginSource, type ExternalSource } from "./plugin-sources.ts";

export interface DependencyCatalog {
  entries: CatalogEntry[];
  /** The marketplace's checkout at the pin. */
  dir: string;
  /** The manifest of an external source at its `sha` when it was already read; absent or undefined when it wasn't. */
  external?: (source: ExternalSource, sha: string) => Promise<PluginManifest | undefined>;
}

/**
 * The name of the first dependency of `manifest` (plugin `own` of `marketplace`) that a pin can't hold, or undefined.
 * A dependency that isn't in the catalog, or lives in another marketplace, is not judged here. Cycles end.
 */
export async function unheldDependency(
  own: string,
  marketplace: string,
  manifest: PluginManifest | undefined,
  catalog: DependencyCatalog,
): Promise<string | undefined> {
  const seen = new Set([own]);
  const queue: [PluginManifest | undefined][] = [[manifest]];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const [m] = next;
    if (!m) continue;
    for (const key of dependencyKeys(m, marketplace)) {
      const at = key.lastIndexOf("@");
      if (key.slice(at + 1) !== marketplace) continue;
      const name = key.slice(0, at);
      if (seen.has(name)) continue;
      seen.add(name);
      const entry = catalog.entries.find((e) => e.name === name);
      if (!entry) continue;
      const info = classifyPluginSource(entry.raw);
      if (info.kind === "refused" || (info.kind === "external" && !info.pinnable)) return name;
      let depManifest: PluginManifest | undefined;
      if (info.kind === "relative") depManifest = await readManifestUnder(catalog.dir, info.path);
      else if (info.source.source !== "archive" && info.source.sha !== undefined)
        depManifest = await catalog.external?.(info.source, info.source.sha);
      if (hasRangedDependency(depManifest)) return name;
      queue.push([depManifest]);
    }
  }
  return undefined;
}
