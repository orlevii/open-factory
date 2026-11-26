import { CONFIG_MSG, MODEL_MSG } from "@open-factory/shared";

/** Field notes of the Configuration form (I4 rules: at most 40 characters, no interpolated value). */
export const CONFIG_FIELD_MSG = {
  duplicate: "Already in the list.",
  editInRaw: "Edit this in Raw JSON.",
  alsoChanged: "Also changed elsewhere.",
  modelChars: MODEL_MSG.chars,
  modelDash: MODEL_MSG.dash,
  enterModel: "Enter a model.",
  warmWindowRange: "Use 1 to 1,440 minutes.",
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
  /** An agent inherit option when no template doc is known; with one it names the value: Template's (opus). */
  inheritAgent: "Template's",
  inheritTemplate: "Claude Code default",
  aliases: "Aliases",
  modelIds: "Model ids",
  custom: "Custom…",
  thisAgent: "This agent",
  useTemplates: "Use template's",
  showInRaw: "Show in Raw JSON",
  showFewer: "Show fewer",
  issuesHeading: "Issues the form can't show",
  templateSkill: "Template skill",
  allSkillsAdded: "Every skill is already added.",
  noSkills: "No skills in Skills yet.",
  insertSecret: "Insert secret",
  secretsLoading: "Loading…",
  secretsLoadError: "Couldn't load secrets.",
  noSecrets: "No secrets yet.",
  addSecret: "Add secret",
  addServer: "Add server",
  applyChanges: "Apply changes",
  override: "Override",
  overridden: "Replaced by this agent",
  kindCommand: "Command",
  kindUrl: "URL",
  urlUnreadable: "URL not shown",
  argsHelp: "One per line.",
  envHelp: "Saved as text in settings.json. Not for secrets.",
  cancel: "Cancel",
} as const;

/** "Adds GH_TOKEN to this agent's secrets." (spec §12.2), shown under the value an Insert secret filled. */
export const secretAddedNote = (name: string, mode: "agent" | "template") =>
  `Adds ${name} to this ${mode}'s secrets.`;

/** The Configuration page's own lines (spec §12.4; I4 rules: at most 40 characters, no interpolated value). */
export const CONFIG_PAGE_MSG = {
  fixJsonToSwitch: "Fix the JSON to switch tabs.",
  fixJsonToSave: "Fix the JSON to save.",
  /** The parse error's marker. Constant: the parser's own message may quote the text, which may hold a secret. */
  invalidJson: "This isn't valid JSON.",
  notObject: "Use a JSON object.",
  discarded: "Discarded.",
  saved: "Saved.",
  changedSince: "Changed since you opened it.",
  hasErrors: "Fix the errors to save.",
  couldntSave: "Couldn't save. Try again.",
  couldntReload: "Couldn't reload. Try again.",
  couldntLoad: "Couldn't load the configuration.",
} as const;

/** Fixed labels of the Configuration page. */
export const CONFIG_PAGE_COPY = {
  title: "Configuration",
  tabForm: "Configuration",
  tabRaw: "Raw JSON",
  viewAgent: "This agent",
  viewCombined: "Combined",
  viewLegend: "Raw JSON view",
  revertRaw: "Revert raw edits",
  save: "Save changes",
  saving: "Saving…",
  discard: "Discard",
  undo: "Undo",
  reload: "Reload",
  openTemplate: "Open template",
  openConfiguration: "Open configuration",
  nextStart: "Next start",
  noCombined: "No combined view while the template has errors.",
  leaveConfirm: "You have unsaved changes. Leave this page and discard them?",
  /** The spawned view's sentence, around the spawner's link: "…configuration, plus @lead's deny rules…". */
  spawnedLead: "Spawned agents use their template's configuration",
  spawnedPlus: ", plus",
  spawnedLimits: "'s deny rules and secret limits.",
} as const;

/** "Saved. Restarts @ana when idle.": only when the restart notice would have shown (running, with changes). */
export const savedRestarts = (slug: string) => `Saved. Restarts @${slug} when idle.`;
/** A save checked against the overlay schema only, because the template is broken (R5). */
export const savedSchemaOnly = (template: string) =>
  `Saved. Checked fully once ${template} is fixed.`;
/** The restart notice above the footer, while the agent is running (client-side `summarizeChanges`). */
export const restartNotice = (slug: string, summary: string) =>
  `Saving restarts @${slug} when idle to apply: ${summary}.`;
/** The restart-pending top line. */
export const restartPendingLine = (summary: string) =>
  summary ? `Restarts when idle to apply: ${summary}.` : "Restarts when idle to apply changes.";
export const archivedLine = (slug: string) =>
  `@${slug} is archived. Changes apply when it's restored.`;
export const brokenTemplateLine = (template: string, slug: string) =>
  `Template ${template} has errors. @${slug} can't start.`;
export const noAgentLine = (slug: string) => `There is no agent @${slug}.`;

/** The template editor's Configuration tab (spec §12.5). */
export const TEMPLATE_TAB_COPY = {
  tab: "Configuration",
  /** On a config file tab while the form holds a draft of it (R2: one draft per file). */
  formHasEdits: "Unsaved changes in Configuration.",
  /** The form while the template has errors: there is no valid doc to edit. */
  broken: "This template has errors. Fix them in the file tabs to edit its configuration here.",
  tabPicker: "File",
  unsaved: "unsaved",
  hasErrors: "has errors",
} as const;

/** "1 agent", "3 agents", "No agents": the template editor's plurals. */
export const agentsPhrase = (n: number) =>
  n === 0 ? "No agents" : n === 1 ? "1 agent" : `${n} agents`;
/** The tab's header line, from the template config GET's counts. */
export const templateUsageLine = (live: number, cantStart: number, valid: boolean) => {
  if (!valid)
    return cantStart > 0 ? `${agentsPhrase(cantStart)} can't start until this is fixed.` : "";
  if (live === 0) return "No agents use this template.";
  return `Used by ${agentsPhrase(live)}. Saving restarts the ones whose configuration changes, when idle.`;
};
/** The jump from the locked form to the file tab holding the edits. */
export const openFileLabel = (file: string) => `Open ${file}`;
/** On the form while a config file tab has unsaved edits (R2). */
export const fileHasEdits = (file: string) =>
  `${file} has unsaved edits. Save or discard them first.`;

/** The Runtime section's notes (spec §2.3). The wording of the local-runtime reason matches Agent details. */
export const RUNTIME_COPY = {
  runtimeNote: "Applies to new agents",
  localDisabled: "Disabled on this factory: set `FACTORY_ALLOW_LOCAL_RUNTIME` on the server",
  imageNote: "Applies at each agent's next start",
  imageNotUsed: "Not used by Local agents",
  permissionNote: "Applies at each agent's next start",
  bypassNeedsDocker: "Bypass needs Docker",
  switchedToAuto: "Set to Auto: Bypass needs Docker",
} as const;

/** The agent Configure page's Runtime switch: the agent's own runtime, changed only here, with a restart. */
export const AGENT_RUNTIME_COPY = {
  note: "Switching restarts the agent once its current turn ends",
  templateDiffers: (runtime: string) => `Its template says ${runtime}, which applies to new agents`,
  bypassTemplate:
    "Local isn't available: the template's permission mode is Bypass, which needs Docker",
  toLocalTitle: (slug: string) => `Run @${slug} outside the sandbox?`,
  toLocalBody:
    "It restarts on this machine with your user's access: every file, repo and key you can reach, not only its workdir and projects.",
  toLocalAction: (slug: string) => `Run @${slug} locally`,
  failed: "Couldn't switch the runtime. Try again.",
} as const;

/** Empty uses the factory's default image: named once it is known, never as a placeholder. */
export const imageNote = (defaultImage: string | undefined) =>
  defaultImage
    ? `${RUNTIME_COPY.imageNote}. Empty uses \`${defaultImage}\``
    : RUNTIME_COPY.imageNote;
