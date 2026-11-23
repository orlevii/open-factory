import { expect, test } from "vitest";
import {
  archivedLine,
  brokenTemplateLine,
  CONFIG_COPY,
  CONFIG_FIELD_MSG,
  CONFIG_FORM_MSG,
  CONFIG_PAGE_MSG,
  noAgentLine,
  restartNotice,
  restartPendingLine,
  savedRestarts,
  savedSchemaOnly,
  secretAddedNote,
} from "./messages";

test("every configuration field message is at most 40 characters", () => {
  for (const [k, m] of Object.entries(CONFIG_FIELD_MSG))
    expect(m.length, k).toBeLessThanOrEqual(40);
});

test("the spec's copy, verbatim", () => {
  expect(CONFIG_FIELD_MSG.duplicate).toBe("Already in the list.");
  expect(CONFIG_FIELD_MSG.editInRaw).toBe("Edit this in Raw JSON.");
  expect(CONFIG_FIELD_MSG.alsoChanged).toBe("Also changed elsewhere.");
});

test("the sections' copy, verbatim", () => {
  expect(CONFIG_COPY.pluginsHelpAgent).toBe(
    "Like formatter@acme. The marketplace must be declared in the template's settings.json.",
  );
  expect(CONFIG_COPY.pluginsHelpTemplate).toBe(
    "Like formatter@acme. The marketplace must be declared in settings.json.",
  );
  expect(CONFIG_COPY.rulesHelp).toBe("Like Bash(git push:*).");
  expect(CONFIG_COPY.notesHelp).toBe(
    "Facts that help auto mode decide, like 'deploys go through CI'.",
  );
  expect(secretAddedNote("GH_TOKEN", "agent")).toBe("Adds GH_TOKEN to this agent's secrets.");
});

test("every configuration form message is at most 40 characters", () => {
  for (const [k, m] of Object.entries(CONFIG_FORM_MSG)) expect(m.length, k).toBeLessThanOrEqual(40);
  expect(CONFIG_FORM_MSG.finishServer).toBe("Finish editing the server first.");
});

test("every Configuration page message is at most 40 characters", () => {
  for (const [k, m] of Object.entries(CONFIG_PAGE_MSG)) expect(m.length, k).toBeLessThanOrEqual(40);
});

test("the page's copy, verbatim (spec §12.4)", () => {
  expect(CONFIG_PAGE_MSG.fixJsonToSwitch).toBe("Fix the JSON to switch tabs.");
  expect(CONFIG_PAGE_MSG.fixJsonToSave).toBe("Fix the JSON to save.");
  expect(CONFIG_PAGE_MSG.changedSince).toBe("Changed since you opened it.");
  expect(CONFIG_PAGE_MSG.discarded).toBe("Discarded.");
  expect(CONFIG_PAGE_MSG.saved).toBe("Saved.");
  expect(savedRestarts("ana")).toBe("Saved. Restarts @ana when idle.");
  expect(savedSchemaOnly("dev")).toBe("Saved. Checked fully once dev is fixed.");
  expect(restartNotice("ana", "model, 1 skill")).toBe(
    "Saving restarts @ana when idle to apply: model, 1 skill.",
  );
  expect(restartPendingLine("model")).toBe("Restarts when idle to apply: model.");
  expect(archivedLine("ana")).toBe("@ana is archived. Changes apply when it's restored.");
  expect(brokenTemplateLine("dev", "ana")).toBe("Template dev has errors. @ana can't start.");
  expect(noAgentLine("x")).toBe("There is no agent @x.");
});
