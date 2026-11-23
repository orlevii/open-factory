import { z } from "zod";
import { formatKey, parseKey } from "./keys.ts";
import { MSG } from "./messages.ts";
import { taskUsageSchema } from "./usage.ts";

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

export const parseTaskKey = (raw: string): number | null => parseKey("T", raw);
export const taskKey = (n: number) => formatKey("T", n);

const BODY_MAX = 64 * 1024;
const bytes = (s: string) => new TextEncoder().encode(s).length;
const oneLine = (s: string) => !/[\r\n]/.test(s);

export const taskTitleSchema = z
  .string()
  .trim()
  .min(1, MSG.titleRequired)
  .max(200, MSG.titleLength)
  .refine(oneLine, MSG.titleOneLine);
export const taskBodySchema = z.string().refine((s) => bytes(s) <= BODY_MAX, MSG.bodyTooLong);
export const commentBodySchema = z
  .string()
  .trim()
  .min(1, MSG.commentRequired)
  .refine((s) => bytes(s) <= BODY_MAX, MSG.bodyTooLong);

const httpUrl = z
  .string()
  .trim()
  .max(2000, MSG.linkUrl)
  .refine((s) => {
    try {
      const u = new URL(s);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }, MSG.linkUrl);
const linkTitle = z.string().trim().min(1).max(200).refine(oneLine, MSG.oneLine).optional();
export const linkInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), target: httpUrl, title: linkTitle }),
  z.object({ kind: z.literal("pr"), target: httpUrl, title: linkTitle }),
  z.object({
    kind: z.literal("file"),
    target: z.string().trim().min(1).max(500).refine(oneLine, MSG.pathOneLine),
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
const deps = z.array(taskRef).max(50, MSG.dependsMax);
const links = z.array(linkInputSchema).max(50, MSG.linksMax);

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

/** Responses (REST). Dates are ISO strings. */
export const taskStatusSchema = z.enum(TASK_STATUSES);
export const taskAgentRefSchema = z.object({
  slug: z.string(),
  displayName: z.string(),
  ended: z.enum(["archived", "terminated"]).optional(),
});
export type TaskAgentRef = z.infer<typeof taskAgentRefSchema>;
export const taskPrincipalSchema = z.union([
  z.object({ kind: z.literal("agent"), slug: z.string() }),
  z.object({ kind: z.literal("user"), handle: z.string() }),
]);
export type TaskPrincipal = z.infer<typeof taskPrincipalSchema>;
export const taskSummarySchema = z.object({
  key: z.string(),
  title: z.string(),
  status: taskStatusSchema,
  assignee: taskAgentRefSchema.nullable(),
  blockedBy: z.array(z.string()),
  createdBy: taskPrincipalSchema,
  updatedAt: z.string(),
});
export type TaskSummary = z.infer<typeof taskSummarySchema>;
export const taskPageSchema = z.object({
  tasks: z.array(taskSummarySchema),
  nextCursor: z.string().nullable(),
});
export type TaskPage = z.infer<typeof taskPageSchema>;
export const taskLinkSchema = z.object({
  kind: z.enum(TASK_LINK_KINDS),
  target: z.string().optional(),
  agent: taskAgentRefSchema.optional(),
  title: z.string().optional(),
});
export type TaskLink = z.infer<typeof taskLinkSchema>;
const taskRelationSchema = z.object({
  key: z.string(),
  title: z.string(),
  status: taskStatusSchema,
  blocked: z.boolean(),
});
export const taskActivitySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("comment"),
    id: z.string(),
    author: taskPrincipalSchema,
    body: z.string(),
    at: z.string(),
  }),
  z.object({
    type: z.literal("event"),
    id: z.string(),
    actor: taskPrincipalSchema,
    event: z.enum(["created", "status", "assignee", "title", "body", "depends_on", "links"]),
    from: z.unknown().optional(),
    to: z.unknown().optional(),
    at: z.string(),
  }),
]);
export type TaskActivity = z.infer<typeof taskActivitySchema>;
export const taskDetailSchema = taskSummarySchema.extend({
  body: z.string(),
  createdAt: z.string(),
  dependsOn: z.array(taskRelationSchema),
  blocks: z.array(taskRelationSchema.extend({ assignee: z.string().nullable() })),
  links: z.array(taskLinkSchema),
  activity: z.array(taskActivitySchema),
  usage: taskUsageSchema,
});
export type TaskDetail = z.infer<typeof taskDetailSchema>;
export const taskChangeResponseSchema = z.object({
  task: taskDetailSchema,
  note: z.string().optional(),
});
export const taskCommentResponseSchema = z.object({
  comment: taskActivitySchema.options[0],
  deliveredTo: z.array(z.string()),
  mentionedHumans: z.array(z.string()),
  notReached: z.array(z.object({ name: z.string(), reason: z.string() })),
  note: z.string().optional(),
});
export type TaskCommentResponse = z.infer<typeof taskCommentResponseSchema>;

const arrayOf = <T extends z.ZodType>(t: T) =>
  z.preprocess((v) => (v === undefined || Array.isArray(v) ? v : [v]), z.array(t));

/** `GET /api/tasks`'s query, as Fastify parses it (a repeated key is an array). Shared so a client
 *  test can check the URLs it builds against the server's contract. */
export const taskListQuerySchema = z.object({
  /** Repeatable (`status=done&status=cancelled`), or `all`; default open and in progress. */
  status: arrayOf(z.union([z.enum(TASK_STATUSES), z.literal("all")])).optional(),
  assignee: z.string().min(1).optional(),
  unassigned: z.enum(["true", "false"]).optional(),
  creator: z.string().min(1).optional(),
  /** `T-41,T-44`: just those tasks (the dependency editor's lookup). */
  keys: z
    .string()
    .min(1)
    .transform((s) =>
      s
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().max(20)).max(50))
    .optional(),
  /** Title search: a case-insensitive substring, `%` and `_` literal. */
  q: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((s) => !s.includes("\u0000"), "must not contain a NUL byte")
    .optional(),
  before: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
