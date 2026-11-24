import path from "node:path";
import type { AgentRow } from "@open-factory/db";
import {
  type AgentOverlay,
  agentOverlaySchema,
  type ConfigDoc,
  effectivePlugins,
  type Library,
  mergeConfig,
  type Pin,
  pinOf,
  type TemplateConfig,
  templateYamlSchema,
  yamlPart,
} from "@open-factory/shared";
import { ApiError } from "../errors.ts";
import type { LibraryIndex } from "../library/library-index.ts";
import type { CatalogEntry } from "../library/marketplaces-service.ts";
import { dependencyKeys, readManifest } from "../library/plugin-settings.ts";
import { classifyPluginSource } from "../library/plugin-sources.ts";
import type { TemplateIndex } from "../templates/template-index.ts";
import { AgentStartError } from "./errors.ts";

/**
 * What an agent runs with: the merged three-part document and the parsed template config (spec §6.1).
 * `templateSkills` is what the template alone lists, so a failure names its fix.
 */
export type Effective = {
  doc: ConfigDoc;
  config: TemplateConfig;
  /** The skills the template alone lists, so a skill that doesn't resolve names its fix. */
  templateSkills: string[];
  /** What the Library resolved the config's skills and plugins to (spec §8.1); kept as `started`. */
  library: Library;
};

/** A pin as the library map carries it (spec §8.1). */
export const pinString = (pin: Pin): string =>
  pin.kind === "commit" ? `commit:${pin.sha}` : pin.kind === "tag" ? `tag:${pin.name}` : pin.kind;

/** What one `libraryOf` call has read: a marketplace's catalog at a ref, and each plugin's dependencies. */
type Memo = {
  catalogs: Map<string, { dir: string | null; entries: CatalogEntry[] }>;
  deps: Map<string, string[]>;
};

const missing = (template: string) => new AgentStartError(`Template ${template} no longer exists.`);
const invalidTemplate = (template: string) =>
  new AgentStartError(`Template ${template} has errors. Fix it in Templates.`, "template");
const invalidOverlay = (slug: string) =>
  new AgentStartError(
    `The configuration of @${slug} is invalid. Fix it in Configuration.`,
    "config",
    `The configuration of @${slug} is invalid.`,
  );

/**
 * The parsed config of a merged doc, with the agent's fixed runtime (spec §6.6); undefined when it doesn't parse.
 */
export function configOf(doc: ConfigDoc, runtime: AgentRow["runtime"]): TemplateConfig | undefined {
  const parsed = templateYamlSchema.safeParse(yamlPart(doc.template));
  return parsed.success ? { ...parsed.data, runtime } : undefined;
}

/**
 * Computes an agent's effective config at a start: the current template plus its overlay (spec §6.1).
 * Messages are the spec constants; they never carry a config value.
 */
export class ConfigResolver {
  constructor(
    private readonly d: {
      templates: Pick<TemplateIndex, "loadValid">;
      library: Pick<LibraryIndex, "resolveSkill" | "marketplaces" | "marketplaceDir" | "catalogAt">;
    },
  ) {}

  /**
   * What the Library resolves a doc to (spec §8.1). Skills: the ref of each one that resolves, "missing" for one that
   * doesn't (the start fails on it; a comparison ignores it). Plugins: each enabled key's pin (`commit:<sha>`,
   * `tag:<name>`, `latest`, `live`), plus the dependencies read from the Library's checkout at that pin; "missing"
   * for a key whose marketplace the doc doesn't declare.
   */
  async libraryOf(doc: ConfigDoc): Promise<Library> {
    const listed = doc.template.skills;
    const skills: Record<string, string> = {};
    for (const name of Array.isArray(listed) ? listed : []) {
      if (typeof name !== "string") continue;
      const r = await this.d.library.resolveSkill(name);
      skills[name] = r.ok ? r.ref : "missing";
    }
    return { skills, plugins: await this.pluginsOf(doc) };
  }

  private async pluginsOf(doc: ConfigDoc): Promise<Record<string, string>> {
    const declared = doc.settings.extraKnownMarketplaces;
    const markets: Record<string, unknown> =
      typeof declared === "object" && declared !== null && !Array.isArray(declared)
        ? (declared as Record<string, unknown>)
        : {};
    const rows = new Map((await this.d.library.marketplaces()).map((r) => [r.name, r]));
    const plugins: Record<string, string> = {};
    // One catalog read per marketplace and ref, and one contents read per plugin, for this call only.
    const memo: Memo = { catalogs: new Map(), deps: new Map() };
    const todo = effectivePlugins(doc);
    for (let key = todo.shift(); key !== undefined; key = todo.shift()) {
      if (key in plugins) continue;
      const at = key.lastIndexOf("@");
      const [name, mkt = ""] = [key.slice(0, at), key.slice(at + 1)];
      if (!Object.hasOwn(markets, mkt)) {
        plugins[key] = "missing";
        continue;
      }
      const pin = pinOf(markets[mkt]);
      plugins[key] = pinString(pin);
      const row = rows.get(mkt);
      if (!row) continue;
      // A dependency naming a marketplace this config doesn't declare stays out: it is never enabled (spec §7.3 step 2).
      for (const dep of await this.dependenciesOf(row, name, pin, memo)) {
        const depMkt = dep.slice(dep.lastIndexOf("@") + 1);
        if (Object.hasOwn(markets, depMkt)) todo.push(dep);
      }
    }
    return plugins;
  }

  /**
   * The dependency keys a relative-path plugin names at the Library's checkout of its marketplace at `pin`; one with no
   * marketplace of its own lives in the plugin's.
   */
  private async dependenciesOf(
    row: Parameters<LibraryIndex["catalogAt"]>[0],
    plugin: string,
    pin: Pin,
    memo: Memo,
  ): Promise<string[]> {
    const ref = pin.kind === "commit" ? pin.sha : pin.kind === "tag" ? pin.name : undefined;
    const where = `${row.name}\0${ref ?? ""}`;
    const key = `${where}\0${plugin}`;
    const known = memo.deps.get(key);
    if (known) return known;
    let catalog = memo.catalogs.get(where);
    if (!catalog) {
      catalog = {
        dir: await this.d.library.marketplaceDir(row, ref),
        entries: (await this.d.library.catalogAt(row, ref)) ?? [],
      };
      memo.catalogs.set(where, catalog);
    }
    const entry = catalog.entries.find((e) => e.name === plugin);
    let deps: string[] = [];
    if (catalog.dir && entry) {
      const info = classifyPluginSource(entry.raw);
      if (info.kind === "relative") {
        const manifest = await readManifest(path.join(catalog.dir, info.path));
        deps = manifest ? dependencyKeys(manifest, row.name) : [];
      }
    }
    memo.deps.set(key, deps);
    return deps;
  }

  async effective(agent: AgentRow): Promise<Effective> {
    let base: ConfigDoc;
    try {
      base = (await this.d.templates.loadValid(agent.template)).doc;
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === "template_missing" || err.code === "template_not_found")
          throw missing(agent.template);
        if (err.code === "template_invalid") throw invalidTemplate(agent.template);
      }
      throw err;
    }
    // A spawned agent's overlay is always empty: it can't be configured (spec §6.1).
    let overlay: AgentOverlay = {};
    if (agent.kind !== "ephemeral") {
      const checked = agentOverlaySchema.safeParse(agent.config);
      if (!checked.success) throw invalidOverlay(agent.slug);
      overlay = checked.data;
    }
    const doc = mergeConfig(base, overlay);
    // The runtime is fixed at creation (spec §6.6): the row wins over the template.
    const config = configOf(doc, agent.runtime);
    // The template parsed on its own, so a failure here is the overlay's.
    if (!config) throw invalidOverlay(agent.slug);
    const listedSkills = base.template.skills;
    const templateSkills = Array.isArray(listedSkills)
      ? listedSkills.filter((p): p is string => typeof p === "string")
      : [];
    return { doc, config, templateSkills, library: await this.libraryOf(doc) };
  }

  /**
   * I2 §6.2: the skills of the running process (`started`), else those the next start would have. None when the config
   * can't be read (a missing or broken template, an invalid overlay): that start fails closed anyway.
   */
  async skillsOf(agent: AgentRow, started: Effective | undefined): Promise<string[]> {
    if (started) return started.config.skills;
    try {
      return (await this.effective(agent)).config.skills;
    } catch (err) {
      if (err instanceof AgentStartError) return [];
      throw err;
    }
  }
}
