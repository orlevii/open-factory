import { describe, expect, test } from "vitest";
import { anyEventSchema, toolMetaSchema } from "./index.ts";

describe("toolMetaSchema", () => {
  test("rejects an unknown tool", () => {
    expect(toolMetaSchema.safeParse({ tool: "Grep", hunks: [] }).success).toBe(false);
  });

  test("rejects a Read without kind text", () => {
    expect(
      toolMetaSchema.safeParse({ tool: "Read", startLine: 1, numLines: 1, totalLines: 1 }).success,
    ).toBe(false);
  });
});

describe("tool_result.meta", () => {
  test("a tool_result without meta parses (a tool the harness keeps no facts for)", () => {
    const row = { type: "tool_result", toolUseId: "t1", content: "ok", isError: false };
    expect(anyEventSchema.parse(row)).toEqual(row);
  });

  test("a tool_result with an invalid meta fails", () => {
    const row = {
      type: "tool_result",
      toolUseId: "t1",
      content: "ok",
      isError: false,
      meta: { tool: "Nope" },
    };
    expect(anyEventSchema.safeParse(row).success).toBe(false);
  });
});
