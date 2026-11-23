import type { AgentRow } from "@open-factory/db";
import {
  type AgentOverlay,
  agentOverlaySchema,
  type ConfigDoc,
  mergeConfig,
  type TemplateConfig,
  templateYamlSchema,
  yamlPart,
} from "@open-factory/shared";
import { ApiError } from "../errors.ts";
import type { TemplateIndex } from "../templates/template-index.ts";
import { AgentStartError } from "./errors.ts";

/**
 * What an agent runs with: the merged three-part document and the parsed template config (spec §6.1).
 * `templatePlugins` is what the template alone lists, so a plugin that fails to install names its fix.
 */
export type Effective = { doc: ConfigDoc; config: TemplateConfig; templatePlugins: string[] };

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
  constructor(private readonly d: { templates: Pick<TemplateIndex, "loadValid"> }) {}

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
    const listed = base.template.plugins;
    const templatePlugins = Array.isArray(listed)
      ? listed.filter((p): p is string => typeof p === "string")
      : [];
    return { doc, config, templatePlugins };
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
