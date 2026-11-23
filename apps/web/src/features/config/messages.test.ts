import { expect, test } from "vitest";
import { CONFIG_COPY, CONFIG_FIELD_MSG, secretAddedNote } from "./messages";

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
