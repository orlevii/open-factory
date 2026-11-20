import { z } from "zod";
import { isValidZone, validateCron } from "./cron.ts";

export const SCHEDULE_STATES = [
  "active",
  "paused",
  "done",
  "skipped_archived",
  "pending_errored",
] as const;
export type ScheduleState = (typeof SCHEDULE_STATES)[number];

/** The body limit (the S6 message cap), shared by the schema and the service. */
export const SCHEDULE_BODY_MAX = 64 * 1024;
const bytes = (s: string) => new TextEncoder().encode(s).length;

export const scheduleBodySchema = z
  .string()
  .refine((s) => bytes(s) >= 1, "The message can't be empty.")
  .refine((s) => bytes(s) <= SCHEDULE_BODY_MAX, "The message is too long (64 KB at most).");

export const cronFieldSchema = z.string().superRefine((s, ctx) => {
  const e = validateCron(s);
  if (e) ctx.addIssue({ code: "custom", message: e });
});

export const zoneSchema = z.string().superRefine((zone, ctx) => {
  if (!isValidZone(zone))
    ctx.addIssue({
      code: "custom",
      message: `Unknown time zone '${zone}'; use an IANA name such as Europe/Berlin.`,
    });
});

export const scheduleMessageToolSchema = z.object({
  body: scheduleBodySchema,
  cron: cronFieldSchema.optional(),
  at: z.string().optional(),
  timezone: zoneSchema.optional(),
  to: z.string().optional(),
});
export const listSchedulesToolSchema = z.object({});
export const cancelScheduleToolSchema = z.object({ id: z.string() });

export const createScheduleBodySchema = z.object({
  target: z.string(),
  cron: cronFieldSchema.optional(),
  at: z.string().optional(),
  timezone: zoneSchema,
  body: scheduleBodySchema,
});
export type CreateScheduleBody = z.infer<typeof createScheduleBodySchema>;
export const patchScheduleBodySchema = createScheduleBodySchema.partial();
export type PatchScheduleBody = z.infer<typeof patchScheduleBodySchema>;

export const scheduleAuthorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("agent"),
    slug: z.string(),
    archived: z.boolean(),
    terminated: z.boolean(),
  }),
  z.object({ kind: z.literal("user"), handle: z.string() }),
]);
export type ScheduleAuthor = z.infer<typeof scheduleAuthorSchema>;

export const scheduleItemSchema = z.object({
  key: z.string(),
  target: z.object({
    slug: z.string(),
    displayName: z.string(),
    archived: z.boolean(),
    terminated: z.boolean(),
  }),
  cron: z.string().optional(),
  at: z.string().optional(),
  timezone: z.string(),
  body: z.string(),
  nextRunAt: z.string().nullable(),
  lastFiredAt: z.string().nullable(),
  paused: z.boolean(),
  done: z.boolean(),
  /** Done one-shots: whether it ran (false when its time came while the target was archived). */
  ran: z.boolean().optional(),
  deleted: z.boolean().optional(),
  createdBy: scheduleAuthorSchema,
  bodyAuthor: scheduleAuthorSchema,
  pendingFiring: z.boolean(),
  state: z.enum(SCHEDULE_STATES),
});
export type ScheduleItem = z.infer<typeof scheduleItemSchema>;

export const scheduleResponseSchema = z.object({ schedule: scheduleItemSchema });
export const scheduleListSchema = z.object({
  schedules: z.array(scheduleItemSchema),
  /** More than the 500 shown exist. */
  more: z.boolean().default(false),
});

/** One in-session (harness) cron, as the agent status lists it. */
export const liveCronSchema = z.object({
  cronId: z.string(),
  humanSchedule: z.string(),
  recurring: z.boolean(),
  durable: z.boolean(),
  nextFireAt: z.string().optional(),
  expiresAt: z.string().optional(),
});
export type LiveCron = z.infer<typeof liveCronSchema>;

export const stopCronsResponseSchema = z.object({ status: z.enum(["stopped", "pending"]) });
