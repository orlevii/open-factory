import { describe, expect, it } from "vitest";
import { modelSchema } from "./models.ts";

describe("modelSchema", () => {
  it.each(["opus", "fable", "claude-sonnet-5-5[1m]", "claude-opus-5-5"])("accepts %s", (m) =>
    expect(modelSchema.safeParse(m).success).toBe(true),
  );
  it.each(["-x", "opus model", "a;b", "", "x".repeat(101)])("refuses %j", (m) =>
    expect(modelSchema.safeParse(m).success).toBe(false),
  );
});
