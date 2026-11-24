import { describe, expect, it } from "vitest";
import { MODEL_ALIASES, MODEL_IDS, modelSchema } from "./models.ts";

it("every alias and id is an accepted model", () => {
  for (const m of [...MODEL_ALIASES, ...MODEL_IDS])
    expect(modelSchema.safeParse(m).success).toBe(true);
});

describe("modelSchema", () => {
  it.each(["opus", "fable", "claude-sonnet-5-5[1m]", "claude-opus-5-5"])("accepts %s", (m) =>
    expect(modelSchema.safeParse(m).success).toBe(true),
  );
  it.each(["-x", "opus model", "a;b", "", "x".repeat(101)])("refuses %j", (m) =>
    expect(modelSchema.safeParse(m).success).toBe(false),
  );
});
