import { z } from "zod";
import { nameSchema, secretNameSchema } from "./names.ts";
import { rateLimitStateSchema } from "./usage.ts";

export const credentialKindSchema = z.enum(["oauth_token", "api_key"]);
export type CredentialKind = z.infer<typeof credentialKindSchema>;
const secretValue = (max: number) => z.string().trim().min(1, "Enter a value.").max(max);

export const credentialSummarySchema = z.object({
  name: z.string(),
  kind: credentialKindSchema,
  lastVerifiedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  expiresAt: z.string().nullable(),
  rejected: z.boolean(),
  usedBy: z.array(z.string()),
  archivedUsedBy: z.array(z.string()),
  rateLimit: rateLimitStateSchema.nullable(),
  pausedUntil: z.string().optional(),
  pauseExact: z.boolean().optional(),
});
export type CredentialSummary = z.infer<typeof credentialSummarySchema>;
export const credentialsListSchema = z.object({ credentials: z.array(credentialSummarySchema) });
export const createCredentialBodySchema = z.object({
  name: nameSchema,
  kind: credentialKindSchema,
  value: secretValue(4096),
});
export const replaceCredentialValueBodySchema = z.object({ value: secretValue(4096) });
export const credentialResponseSchema = z.object({ credential: credentialSummarySchema });

export const secretSummarySchema = z.object({
  name: z.string(),
  updatedAt: z.string(),
  usedBy: z.array(z.string()),
});
export type SecretSummary = z.infer<typeof secretSummarySchema>;
export const secretsListSchema = z.object({ secrets: z.array(secretSummarySchema) });
export const putSecretBodySchema = z.object({
  value: z
    .string()
    .min(1, "Enter a value.")
    .max(64 * 1024),
});
export const secretParamsSchema = z.object({ name: secretNameSchema });

export const projectSummarySchema = z.object({
  name: z.string(),
  hostPath: z.string(),
  grantedTo: z.array(z.string()),
  archivedGrantedTo: z.array(z.string()),
  templates: z.array(z.string()),
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export const projectsListSchema = z.object({ projects: z.array(projectSummarySchema) });
export const createProjectBodySchema = z.object({
  name: nameSchema,
  hostPath: z.string().trim().min(1),
});
export const patchProjectBodySchema = z.object({ hostPath: z.string().trim().min(1) });
export const projectResponseSchema = z.object({ project: projectSummarySchema });

export const FACTORY_BOUNDS = {
  maxRunningAgents: [1, 64],
  defaultWarmWindowMinutes: [1, 1440],
  memberUpdateDebounceSeconds: [0, 86_400],
  loopGuardMessages: [2, 1000],
  loopGuardWindowMinutes: [1, 1440],
} as const;

export const factorySettingsSchema = z.object({
  maxRunningAgents: z.number().int(),
  defaultWarmWindowMinutes: z.number().int(),
  memberUpdateDebounceSeconds: z.number().int(),
  loopGuardMessages: z.number().int(),
  loopGuardWindowMinutes: z.number().int(),
  allowLocalRuntime: z.boolean(),
  updatedAt: z.string().nullable(),
  /** The @handle of the last editor. */
  updatedBy: z.string().nullable(),
});
export type FactorySettingsDto = z.infer<typeof factorySettingsSchema>;

const bounded = ([lo, hi]: readonly [number, number]) => {
  const msg = `Enter a whole number from ${lo} to ${hi}.`;
  // The type error too (a string, null): every rejection of the field is the §12.10 sentence.
  return z.number({ error: msg }).int(msg).min(lo, msg).max(hi, msg).optional();
};
export const patchFactorySettingsSchema = z.strictObject({
  maxRunningAgents: bounded(FACTORY_BOUNDS.maxRunningAgents),
  defaultWarmWindowMinutes: bounded(FACTORY_BOUNDS.defaultWarmWindowMinutes),
  memberUpdateDebounceSeconds: bounded(FACTORY_BOUNDS.memberUpdateDebounceSeconds),
});
export type PatchFactorySettings = z.infer<typeof patchFactorySettingsSchema>;
