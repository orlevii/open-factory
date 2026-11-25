import { expect, test } from "vitest";
import {
  agentsPhrase,
  archivedLine,
  brokenTemplateLine,
  CONFIG_FIELD_MSG,
  CONFIG_PAGE_MSG,
  fileHasEdits,
  noAgentLine,
  restartNotice,
  restartPendingLine,
  savedRestarts,
  savedSchemaOnly,
  TEMPLATE_TAB_COPY,
  templateUsageLine,
} from "./messages";

test.each([
  ["field", CONFIG_FIELD_MSG],
  ["page", CONFIG_PAGE_MSG],
])("every configuration %s message is at most 40 characters", (_name, msgs) => {
  for (const [k, m] of Object.entries(msgs)) expect(m.length, k).toBeLessThanOrEqual(40);
});

test("the page's interpolated lines (spec §12.4)", () => {
  expect(savedRestarts("ana")).toBe("Saved. Restarts @ana when idle.");
  expect(savedSchemaOnly("dev")).toBe("Saved. Checked fully once dev is fixed.");
  expect(restartNotice("ana", "model, 1 skill")).toBe(
    "Saving restarts @ana when idle to apply: model, 1 skill.",
  );
  expect(restartPendingLine("")).toBe("Restarts when idle to apply changes.");
  expect(restartPendingLine("model")).toBe("Restarts when idle to apply: model.");
  expect(archivedLine("ana")).toBe("@ana is archived. Changes apply when it's restored.");
  expect(brokenTemplateLine("dev", "ana")).toBe("Template dev has errors. @ana can't start.");
  expect(noAgentLine("x")).toBe("There is no agent @x.");
});

test("the template tab's copy and plurals (spec §12.5)", () => {
  expect(agentsPhrase(0)).toBe("No agents");
  expect(agentsPhrase(1)).toBe("1 agent");
  expect(agentsPhrase(3)).toBe("3 agents");
  expect(templateUsageLine(3, 0, true)).toBe(
    "Used by 3 agents. Saving restarts the ones whose configuration changes, when idle.",
  );
  expect(templateUsageLine(1, 0, true)).toBe(
    "Used by 1 agent. Saving restarts the ones whose configuration changes, when idle.",
  );
  expect(templateUsageLine(0, 0, true)).toBe("No agents use this template.");
  expect(templateUsageLine(3, 3, false)).toBe("3 agents can't start until this is fixed.");
  expect(templateUsageLine(1, 1, false)).toBe("1 agent can't start until this is fixed.");
  expect(fileHasEdits("settings.json")).toBe(
    "settings.json has unsaved edits. Save or discard them first.",
  );
  expect(TEMPLATE_TAB_COPY.formHasEdits).toBe("Unsaved changes in Configuration.");
});
