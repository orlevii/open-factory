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
  warmWindowMinutes: [1, 1440],
  memberUpdateDebounceSeconds: [0, 86_400],
} as const;

const bounded = ([lo, hi]: readonly [number, number]) => {
  const msg = `Enter a whole number from ${lo} to ${hi}.`;
  // The type error too (a string, null): every rejection of the field is the §12.10 sentence.
  return z.number({ error: msg }).int(msg).min(lo, msg).max(hi, msg);
};

/** The values stored in `factory_settings.settings`; a missing key reads as its default. */
export const factorySettingsValuesSchema = z.object({
  warmWindowMinutes: bounded(FACTORY_BOUNDS.warmWindowMinutes).default(70),
  memberUpdateDebounceSeconds: bounded(FACTORY_BOUNDS.memberUpdateDebounceSeconds).default(30),
});
export type FactorySettingsValues = z.infer<typeof factorySettingsValuesSchema>;

/**
 * Reads the stored object key by key: a missing, hand-edited or out-of-range key reads as its default, so one bad
 * key never stops the factory from booting. (PATCH stays strict.)
 */
export function readFactorySettingsValues(raw: unknown): FactorySettingsValues {
  const stored: Record<string, unknown> =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const defaults = factorySettingsValuesSchema.parse({});
  const read = (k: keyof FactorySettingsValues) => {
    const r = factorySettingsValuesSchema.shape[k].safeParse(stored[k]);
    return r.success ? r.data : defaults[k];
  };
  return {
    warmWindowMinutes: read("warmWindowMinutes"),
    memberUpdateDebounceSeconds: read("memberUpdateDebounceSeconds"),
  };
}

export const factorySettingsSchema = factorySettingsValuesSchema.extend({
  allowLocalRuntime: z.boolean(),
  /** `FACTORY_DEFAULT_IMAGE`: the image a template with no `image:` uses. Read-only. */
  defaultImage: z.string(),
  updatedAt: z.string().nullable(),
  /** The @handle of the last editor. */
  updatedBy: z.string().nullable(),
});
export type FactorySettingsDto = z.infer<typeof factorySettingsSchema>;

export const patchFactorySettingsSchema = z.strictObject({
  warmWindowMinutes: bounded(FACTORY_BOUNDS.warmWindowMinutes).optional(),
  memberUpdateDebounceSeconds: bounded(FACTORY_BOUNDS.memberUpdateDebounceSeconds).optional(),
});
export type PatchFactorySettings = z.infer<typeof patchFactorySettingsSchema>;
