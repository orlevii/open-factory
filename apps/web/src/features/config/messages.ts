import { CONFIG_MSG, MODEL_MSG, PLUGIN_REF_MSG } from "@open-factory/shared";

/** Field notes of the Configuration form (I4 rules: at most 40 characters, no interpolated value). */
export const CONFIG_FIELD_MSG = {
  duplicate: "Already in the list.",
  editInRaw: "Edit this in Raw JSON.",
  alsoChanged: "Also changed elsewhere.",
  modelChars: MODEL_MSG.chars,
  modelDash: MODEL_MSG.dash,
  enterModel: "Enter a model.",
  warmWindowRange: "Use 1 to 1,440 minutes.",
  maxLiveSpawnsRange: "Use 0 to 50.",
  pluginRef: PLUGIN_REF_MSG,
  envName: CONFIG_MSG.envName,
  factoryEnv: CONFIG_MSG.factoryEnv,
  factoryServer: CONFIG_MSG.factoryServer,
  tooManyServers: CONFIG_MSG.tooManyServers,
  enterName: "Enter a name.",
  enterCommand: "Enter a command.",
  enterUrl: "Enter a URL.",
  urlScheme: "Use an http or https URL.",
  headerName: "Use a valid header name.",
} as const;

/** Labels and lines the spec fixes verbatim. Not field messages, so not bound by the 40-character rule. */
export const CONFIG_COPY = {
  inheritAgent: "Inherit from template",
  inheritTemplate: "Claude Code default",
  aliases: "Aliases",
  modelIds: "Model ids",
  custom: "Custom…",
  thisAgent: "This agent",
  useTemplates: "Use template's",
  showInRaw: "Show in Raw JSON",
  showFewer: "Show fewer",
  issuesHeading: "Issues the form can't show",
  pluginsHelpAgent:
    "Like formatter@acme. The marketplace must be declared in the template's settings.json.",
  pluginsHelpTemplate: "Like formatter@acme. The marketplace must be declared in settings.json.",
  rulesHelp: "Like Bash(git push:*).",
  notesHelp: "Facts that help auto mode decide, like 'deploys go through CI'.",
  templateSkill: "Template skill",
  insertSecret: "Insert secret",
  addSecret: "Add secret",
  addServer: "Add server",
  override: "Override",
  overridden: "Replaced by this agent",
  kindCommand: "Command",
  kindUrl: "URL",
  urlUnreadable: "URL not shown",
  argsHelp: "One per line.",
  envHelp: "Saved as text in settings.json. Not for secrets.",
  done: "Done",
  cancel: "Cancel",
} as const;

/** "Adds GH_TOKEN to this agent's secrets." (spec §12.2), shown under the value an Insert secret filled. */
export const secretAddedNote = (name: string, mode: "agent" | "template") =>
  `Adds ${name} to this ${mode}'s secrets.`;
