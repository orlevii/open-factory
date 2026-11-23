import { MODEL_MSG } from "@open-factory/shared";

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
} as const;
