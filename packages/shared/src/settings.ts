import { z } from "zod";
import { nameSchema, secretNameSchema } from "./names.ts";

export const credentialKindSchema = z.enum(["oauth_token", "api_key"]);
export type CredentialKind = z.infer<typeof credentialKindSchema>;
const secretValue = (max: number) => z.string().trim().min(1, "Enter a value.").max(max);

export const credentialSummarySchema = z.object({
  name: z.string(),
  kind: credentialKindSchema,
  lastVerifiedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  usedBy: z.array(z.string()),
  archivedUsedBy: z.array(z.string()),
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
