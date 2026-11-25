/**
 * Who uses a marketplace and its plugins (spec §7.4, §9.1, §9.4): the valid templates' declarations
 * (`extraKnownMarketplaces`, `enabledPlugins`) and the agents' overlay plugins, which run at their template's pin.
 */
import { type AgentOverlay, type ConfigDoc, effectivePlugins, pinOf } from "@open-factory/shared";
import { pinString } from "../agents/config-resolver.ts";
import { isRecord } from "./common.ts";

export interface Declarations {
  /** Each valid template's last good config, by name. */
  templates: Map<string, ConfigDoc>;
  agents: Array<{ slug: string; template: string; config: AgentOverlay }>;
}

const marketplaceOf = (key: string) => key.slice(key.lastIndexOf("@") + 1);

const declarationsOf = (doc: ConfigDoc): Record<string, unknown> =>
  isRecord(doc.settings.extraKnownMarketplaces) ? doc.settings.extraKnownMarketplaces : {};

const overlayPlugins = (a: Declarations["agents"][number]): string[] =>
  effectivePlugins({ settings: a.config.settings ?? {} });

/** A template's pin on a marketplace: `commit:<sha>`, `tag:<name>`, `latest` or `live`. */
const pinOnMarketplace = (doc: ConfigDoc | undefined, mkt: string): string =>
  pinString(pinOf(doc ? declarationsOf(doc)[mkt] : undefined));

/** The templates that declare the marketplace or enable one of its plugins, and the agents that enable one in an overlay. */
export function marketplaceUsers(
  d: Declarations,
  name: string,
): { templates: string[]; agents: string[] } {
  const templates = [...d.templates]
    .filter(
      ([, doc]) =>
        Object.hasOwn(declarationsOf(doc), name) ||
        effectivePlugins(doc).some((k) => marketplaceOf(k) === name),
    )
    .map(([t]) => t)
    .sort();
  const agents = d.agents
    .filter((a) => overlayPlugins(a).some((k) => marketplaceOf(k) === name))
    .map((a) => a.slug)
    .sort();
  return { templates, agents };
}

/** Every pin a declaration holds: a commit, a tag, or null for Latest and for a live folder (nothing to keep). */
export function declaredRefs(d: Declarations): Array<{ marketplace: string; ref: string | null }> {
  const out: Array<{ marketplace: string; ref: string | null }> = [];
  for (const doc of d.templates.values()) {
    for (const mkt of Object.keys(declarationsOf(doc))) {
      const pin = pinOf(declarationsOf(doc)[mkt]);
      out.push({
        marketplace: mkt,
        ref: pin.kind === "commit" ? pin.sha : pin.kind === "tag" ? pin.name : null,
      });
    }
  }
  return out;
}

/** The users of one plugin key, each with the pin it runs at. */
export function pluginUsers(
  d: Declarations,
  key: string,
): {
  templates: Array<{ name: string; pin: string; agents: number }>;
  overlays: Array<{ agent: string; template: string; pin: string }>;
} {
  const mkt = marketplaceOf(key);
  const templates = [...d.templates]
    .filter(([, doc]) => effectivePlugins(doc).includes(key))
    .map(([name, doc]) => ({
      name,
      pin: pinOnMarketplace(doc, mkt),
      agents: d.agents.filter((a) => a.template === name).length,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const overlays = d.agents
    .filter((a) => overlayPlugins(a).includes(key))
    .map((a) => ({
      agent: a.slug,
      template: a.template,
      pin: pinOnMarketplace(d.templates.get(a.template), mkt),
    }))
    .sort((a, b) => a.agent.localeCompare(b.agent));
  return { templates, overlays };
}
