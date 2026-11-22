import { describe, expect, test } from "vitest";
import { anyEventSchema, toolMetaSchema } from "./index.ts";

const hunk = {
  oldStart: 1,
  oldLines: 2,
  newStart: 1,
  newLines: 3,
  lines: [" a", "-b", "+c", "+d"],
};

describe("toolMetaSchema", () => {
  test("parses every variant", () => {
    const samples = [
      { tool: "Edit", hunks: [hunk] },
      { tool: "Edit", hunks: [hunk], partial: true },
      { tool: "MultiEdit", hunks: [hunk, hunk] },
      { tool: "Write", type: "create", hunks: [] },
      { tool: "Write", type: "update", hunks: [hunk], partial: true },
      { tool: "Bash", interrupted: false },
      { tool: "Bash", interrupted: true, backgroundTaskId: "b1", stderr: "boom" },
      { tool: "Read", kind: "text", startLine: 1, numLines: 120, totalLines: 340 },
      { tool: "ReadImage", bytes: 1024 },
      { tool: "ReadImage", bytes: 1024, width: 1280, height: 720 },
      { tool: "Agent" },
      { tool: "Agent", async: true },
      { tool: "Agent", toolUses: 12, tokens: 23000, durationMs: 41000 },
    ];
    for (const s of samples) expect(toolMetaSchema.parse(s)).toEqual(s);
  });

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
  test("a tool_result without meta parses (old rows)", () => {
    const row = { type: "tool_result", toolUseId: "t1", content: "ok", isError: false };
    expect(anyEventSchema.parse(row)).toEqual(row);
  });

  test("a tool_result carries meta", () => {
    const row = {
      type: "tool_result",
      toolUseId: "t1",
      content: "ok",
      isError: false,
      meta: { tool: "Bash", interrupted: false, backgroundTaskId: "b1" },
    };
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
