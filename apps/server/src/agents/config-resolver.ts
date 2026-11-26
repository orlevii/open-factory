import {
  type AgentOverlay,
  agentOverlaySchema,
  type ConfigDoc,
  type Library,
  mergeConfig,
  type TemplateConfig,
  templateYamlSchema,
  yamlPart,
} from "@open-factory/shared";
import { ApiError } from "../errors.ts";
import type { LibraryIndex } from "../library/library-index.ts";
import type { AgentRecord } from "../principals/principal-store.ts";
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
  /** What the Library resolved the config's skills to (spec §8.1); kept as `started`. */
  library: Library;
};

const missing = (template: string) => new AgentStartError(`Template ${template} no longer exists.`);
const invalidTemplate = (template: string) =>
  new AgentStartError(`Template ${template} has errors. Fix it in Templates.`, "template");
const invalidOverlay = (handle: string) =>
  new AgentStartError(
    `The configuration of @${handle} is invalid. Fix it in Configuration.`,
    "config",
    `The configuration of @${handle} is invalid.`,
  );

/**
 * The parsed config of a merged doc, with the agent's fixed runtime (spec §6.6); undefined when it doesn't parse.
 */
export function configOf(
  doc: ConfigDoc,
  runtime: AgentRecord["runtime"],
): TemplateConfig | undefined {
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
      library: Pick<LibraryIndex, "resolveSkill">;
    },
  ) {}

  /**
   * What the Library resolves a doc to (spec §8.1). Skills: the ref of each one that resolves, "missing" for one that
   * doesn't (the start fails on it; a comparison ignores it).
   */
  async libraryOf(doc: ConfigDoc): Promise<Library> {
    const listed = doc.template.skills;
    const skills: Record<string, string> = {};
    for (const name of Array.isArray(listed) ? listed : []) {
      if (typeof name !== "string") continue;
      const r = await this.d.library.resolveSkill(name);
      skills[name] = r.ok ? r.ref : "missing";
    }
    return { skills };
  }

  async effective(agent: AgentRecord): Promise<Effective> {
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
      if (!checked.success) throw invalidOverlay(agent.handle);
      overlay = checked.data;
    }
    const doc = mergeConfig(base, overlay);
    // The runtime is fixed at creation (spec §6.6): the row wins over the template.
    const config = configOf(doc, agent.runtime);
    // The template parsed on its own, so a failure here is the overlay's.
    if (!config) throw invalidOverlay(agent.handle);
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
  async skillsOf(agent: AgentRecord, started: Effective | undefined): Promise<string[]> {
    if (started) return started.config.skills;
    try {
      return (await this.effective(agent)).config.skills;
    } catch (err) {
      if (err instanceof AgentStartError) return [];
      throw err;
    }
  }
}
