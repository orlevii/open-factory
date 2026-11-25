import { z } from "zod";

export const USAGE_DAYS = [7, 30, 90] as const;
export type UsageDays = (typeof USAGE_DAYS)[number];
export const usageDaysSchema = z.coerce
  .number()
  .pipe(z.union([z.literal(7), z.literal(30), z.literal(90)]));

export const totalsSchema = z.object({
  costUsd: z.number(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cacheWriteTokens: z.number().int(),
  cacheReadTokens: z.number().int(),
  turns: z.number().int(),
});
export type Totals = z.infer<typeof totalsSchema>;

export const dayUsageSchema = totalsSchema.extend({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type DayUsage = z.infer<typeof dayUsageSchema>;
export const dailyUsageSchema = z.object({ timezone: z.string(), days: z.array(dayUsageSchema) });
export type DailyUsage = z.infer<typeof dailyUsageSchema>;

const agentKind = z.enum(["persistent", "ephemeral"]);
export const agentUsageRowSchema = z.object({
  slug: z.string(),
  displayName: z.string(),
  kind: agentKind,
  spawnerSlug: z.string().optional(),
  archived: z.boolean(),
  terminated: z.boolean(),
  own: totalsSchema,
  spawned: totalsSchema.optional(),
  total: totalsSchema,
});
export type AgentUsageRow = z.infer<typeof agentUsageRowSchema>;
export const agentsUsageSchema = z.object({ agents: z.array(agentUsageRowSchema) });
export type AgentsUsage = z.infer<typeof agentsUsageSchema>;

export const rateLimitStateSchema = z.object({
  status: z.enum(["allowed", "allowed_warning", "rejected"]),
  type: z.string().nullable(),
  utilization: z.number().nullable(),
  resetsAt: z.string().nullable(),
  observedAt: z.string(),
});
export type RateLimitState = z.infer<typeof rateLimitStateSchema>;

export const credentialUsageRowSchema = z.object({
  name: z.string(),
  kind: z.enum(["oauth_token", "api_key"]),
  totals: totalsSchema,
  agents: z.array(z.object({ slug: z.string(), costUsd: z.number() })),
  rateLimit: rateLimitStateSchema.nullable(),
  pausedUntil: z.string().optional(),
  pauseExact: z.boolean().optional(),
});
export type CredentialUsageRow = z.infer<typeof credentialUsageRowSchema>;
export const credentialsUsageSchema = z.object({
  credentials: z.array(credentialUsageRowSchema),
  unattributed: totalsSchema,
});
export type CredentialsUsage = z.infer<typeof credentialsUsageSchema>;

export const agentUsageSchema = z.object({
  agent: z.object({ slug: z.string(), displayName: z.string(), kind: agentKind }),
  timezone: z.string(),
  total: totalsSchema,
  own: totalsSchema,
  daily: z.array(dayUsageSchema),
  /** `model` is null for turns that never reported one; the UI labels it. */
  byModel: z.array(totalsSchema.extend({ model: z.string().nullable() })),
  byTask: z.array(totalsSchema.extend({ key: z.string(), title: z.string() })),
  spawned: z.array(
    totalsSchema.extend({ slug: z.string(), displayName: z.string(), terminated: z.boolean() }),
  ),
});
export type AgentUsage = z.infer<typeof agentUsageSchema>;

export const taskUsageSchema = z
  .object({ costUsd: z.number(), turns: z.number().int() })
  .nullable();
