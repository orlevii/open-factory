import { z } from "zod";

export const TASK_STATUSES = ["open", "in_progress", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_NOTICES = [
  "done",
  "cancelled",
  "unblocked",
  "unassigned",
  "status_changed",
  "edited",
] as const;
export type TaskNotice = (typeof TASK_NOTICES)[number];
export const TASK_LINK_KINDS = ["url", "pr", "file", "agent"] as const;

export function parseTaskKey(raw: string): number | null {
  const m = /^(?:t-)?([1-9][0-9]{0,8})$/i.exec(raw.trim());
  return m ? Number(m[1]) : null;
}
export const taskKey = (n: number) => `T-${n}`;

const BODY_MAX = 64 * 1024;
const bytes = (s: string) => new TextEncoder().encode(s).length;
const oneLine = (s: string) => !/[\r\n]/.test(s);

export const taskTitleSchema = z
  .string()
  .trim()
  .min(1, "Enter a title.")
  .max(200, "Keep the title to 200 characters or fewer.")
  .refine(oneLine, "Keep the title on one line.");
export const taskBodySchema = z
  .string()
  .refine((s) => bytes(s) <= BODY_MAX, "Shorten the description to 64 KB or less.");
export const commentBodySchema = z
  .string()
  .trim()
  .min(1, "Write a comment first.")
  .refine((s) => bytes(s) <= BODY_MAX, "Shorten the comment to 64 KB or less.");

const httpUrl = z
  .string()
  .trim()
  .max(2000, "Links must be http(s) URLs.")
  .refine((s) => {
    try {
      const u = new URL(s);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }, "Links must be http(s) URLs.");
const linkTitle = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(oneLine, "Keep it on one line.")
  .optional();
export const linkInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), target: httpUrl, title: linkTitle }),
  z.object({ kind: z.literal("pr"), target: httpUrl, title: linkTitle }),
  z.object({
    kind: z.literal("file"),
    target: z.string().trim().min(1).max(500).refine(oneLine, "Keep the path on one line."),
    title: linkTitle,
  }),
  z.object({
    kind: z.literal("agent"),
    target: z.string().trim().min(1).max(64),
    title: linkTitle,
  }),
]);
export type LinkInput = z.infer<typeof linkInputSchema>;

const taskRef = z.string().min(1).max(20);
const name = z.string().min(1).max(64);
const deps = z.array(taskRef).max(50, "A task can depend on at most 50 tasks.");
const links = z.array(linkInputSchema).max(50, "A task can have at most 50 links.");

/** MCP inputs (snake_case, as the product's tool signatures). Parameter semantics only; rules live in CLAUDE.md. */
export const createTaskToolSchema = z.object({
  title: taskTitleSchema.describe("One line"),
  body: taskBodySchema.optional().describe("Markdown brief"),
  assignee: name.optional().describe('An agent slug, or "me"'),
  depends_on: deps.optional().describe("Task keys this task waits on, like T-41"),
  links: links.optional(),
});
export const updateTaskToolSchema = z.object({
  id: taskRef.describe("Task key, like T-42"),
  title: taskTitleSchema.optional(),
  body: taskBodySchema.optional(),
  status: z.enum(TASK_STATUSES).optional(),
  assignee: name.nullable().optional().describe('An agent slug, "me", or null to unassign'),
  depends_on: deps.optional().describe("The full new list (replaces the old one)"),
  links: links.optional().describe("The full new list (replaces the old one)"),
});
export const listTasksToolSchema = z.object({
  status: z
    .array(z.enum(TASK_STATUSES))
    .min(1)
    .optional()
    .describe('Default ["open","in_progress"]'),
  assignee: name.optional().describe('An agent slug or "me"'),
  unassigned: z
    .literal(true)
    .optional()
    .describe("Only tasks with no assignee (instead of assignee)"),
  created_by: name.optional().describe('An agent slug, a human "@handle", or "me"'),
  limit: z.number().int().min(1).max(200).optional().describe("Default 50"),
});
export const getTaskToolSchema = z.object({
  id: taskRef,
  comments_before: z
    .string()
    .min(1)
    .optional()
    .describe("A comment id: return the 50 comments before it"),
});
export const commentTaskToolSchema = z.object({ id: taskRef, body: commentBodySchema });

/** REST inputs (camelCase). */
export const createTaskBodySchema = z.object({
  title: taskTitleSchema,
  body: taskBodySchema.default(""),
  assignee: name.nullable().optional(),
  dependsOn: deps.default([]),
  links: links.default([]),
});
export const patchTaskBodySchema = z.object({
  title: taskTitleSchema.optional(),
  body: taskBodySchema.optional(),
  status: z.enum(TASK_STATUSES).optional(),
  assignee: name.nullable().optional(),
  dependsOn: deps.optional(),
  links: links.optional(),
});
export const taskCommentBodySchema = z.object({ body: commentBodySchema });
