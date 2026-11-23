import { expect, it } from "vitest";
import { MODEL_ALIASES, MODEL_IDS, modelSchema } from "./models.ts";

it("every alias and id is an accepted model", () => {
  for (const m of [...MODEL_ALIASES, ...MODEL_IDS])
    expect(modelSchema.safeParse(m).success).toBe(true);
});
