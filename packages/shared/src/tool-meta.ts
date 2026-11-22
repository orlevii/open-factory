import { z } from "zod";

/** One unified-diff hunk, as Claude Code's `structuredPatch` holds it. */
const hunkSchema = z.object({
  oldStart: z.number(),
  oldLines: z.number(),
  newStart: z.number(),
  newLines: z.number(),
  lines: z.array(z.string()),
});

/**
 * Per-tool facts the harness keeps from a tool result (spec §9.1). Unknown
 * tools carry none; a `tool_result` without meta (old rows) still parses.
 */
export const toolMetaSchema = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("Edit"),
    hunks: z.array(hunkSchema),
    partial: z.boolean().optional(),
  }),
  z.object({
    tool: z.literal("MultiEdit"),
    hunks: z.array(hunkSchema),
    partial: z.boolean().optional(),
  }),
  z.object({
    tool: z.literal("Write"),
    type: z.enum(["create", "update"]),
    hunks: z.array(hunkSchema),
    partial: z.boolean().optional(),
  }),
  z.object({
    tool: z.literal("Bash"),
    interrupted: z.boolean(),
    backgroundTaskId: z.string().optional(),
    stderr: z.string().optional(),
  }),
  z.object({
    tool: z.literal("Read"),
    kind: z.literal("text"),
    startLine: z.number(),
    numLines: z.number(),
    totalLines: z.number(),
  }),
  z.object({
    tool: z.literal("ReadImage"),
    bytes: z.number(),
    width: z.number().optional(),
    height: z.number().optional(),
  }),
  z.object({
    tool: z.literal("Agent"),
    async: z.boolean().optional(),
    toolUses: z.number().optional(),
    tokens: z.number().optional(),
    durationMs: z.number().optional(),
  }),
]);

export type ToolMeta = z.infer<typeof toolMetaSchema>;
export type ToolMetaHunk = z.infer<typeof hunkSchema>;
