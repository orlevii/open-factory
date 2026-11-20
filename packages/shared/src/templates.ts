import { z } from "zod";
import { imageStatusSchema } from "./images.ts";
import { hostSkillSchema, nameSchema, secretNameSchema } from "./names.ts";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const TEMPLATE_FILES = ["template.yaml", "AGENTS.md", "settings.json", "mcp.json"] as const;
export type TemplateFile = (typeof TEMPLATE_FILES)[number];
export const templateFileSchema = z.enum(TEMPLATE_FILES);

/** Passed to the CLI as `--model <m>`: a leading dash could be read as another flag. */
const modelSchema = z
  .string()
  .min(1)
  .refine((v) => !v.startsWith("-"), "Use a model alias or id such as haiku or claude-sonnet-4-5.");

const pluginRef = z.string().regex(/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/, "Use name@marketplace.");

// The Docker image reference grammar (distribution/reference): `[registry[:port]/]path[:tag][@algo:hex]`.
const domainPart = "(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])";
const pathPart = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
const IMAGE_REF = new RegExp(
  `^(?:${domainPart}(?:\\.${domainPart})*(?::[0-9]+)?/)?${pathPart}(?:/${pathPart})*` +
    "(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?" +
    // Only the digest Docker accepts: a malformed one is a validation error, not a Docker 400.
    "(?:@sha256:[0-9a-f]{64})?$",
);
const USER_TAG_PREFIX = "open-factory-user/";
/**
 * An image reference only (no `..`, whitespace, `?` or `#`): it reaches Docker API paths that aren't encoded.
 * A built user image is named by its bare folder name, never by its `open-factory-user/` tag (spec §10.1),
 * so the tag can't bypass the no-pull rule.
 */
export const imageRefSchema = z
  .string()
  .max(255)
  .regex(IMAGE_REF, "Use a Docker image reference, like ghcr.io/org/image:tag.")
  .refine((v) => !v.startsWith(USER_TAG_PREFIX), {
    error: (iss) => {
      const name = String(iss.input).slice(USER_TAG_PREFIX.length).split(/[:@]/)[0];
      return `Use the bare name ${name} for a user image.`;
    },
  });

export const templateConfigSchema = z.object({
  name: nameSchema,
  displayName: z.string().min(1).max(80),
  description: z.string().max(500),
  runtime: z.enum(["docker", "local"]),
  image: imageRefSchema.optional(),
  permissionMode: z.enum(["auto", "bypass"]),
  model: modelSchema.optional(),
  effort: z.enum(EFFORTS).optional(),
  projects: z.array(nameSchema),
  skills: z.array(hostSkillSchema),
  localSkills: z.boolean(),
  plugins: z.array(pluginRef),
  secrets: z.array(secretNameSchema),
  canSpawn: z.array(nameSchema),
  maxLiveSpawns: z.number().int().min(0).max(50),
  warmWindowMinutes: z.number().int().min(1).max(1440).optional(),
});
export type TemplateConfig = z.infer<typeof templateConfigSchema>;

/** template.yaml as written (snake_case, strict), transformed into TemplateConfig. */
export const templateYamlSchema = z
  .strictObject({
    name: nameSchema,
    display_name: z.string().min(1).max(80),
    description: z.string().max(500).default(""),
    runtime: z.enum(["docker", "local"]).default("docker"),
    image: imageRefSchema.optional(),
    permission_mode: z.enum(["auto", "bypass"]).default("auto"),
    model: modelSchema.optional(),
    effort: z.enum(EFFORTS).optional(),
    projects: z.array(nameSchema).default([]),
    skills: z.array(hostSkillSchema).default([]),
    local_skills: z.boolean().default(true),
    plugins: z.array(pluginRef).default([]),
    secrets: z.array(secretNameSchema).default([]),
    can_spawn: z.array(nameSchema).default([]),
    max_live_spawns: z.number().int().min(0).max(50).default(5),
    warm_window_minutes: z.number().int().min(1).max(1440).optional(),
  })
  .transform(
    (y): TemplateConfig => ({
      name: y.name,
      displayName: y.display_name,
      description: y.description,
      runtime: y.runtime,
      ...(y.image ? { image: y.image } : {}),
      permissionMode: y.permission_mode,
      ...(y.model ? { model: y.model } : {}),
      ...(y.effort ? { effort: y.effort } : {}),
      projects: y.projects,
      skills: y.skills,
      localSkills: y.local_skills,
      plugins: y.plugins,
      secrets: y.secrets,
      canSpawn: y.can_spawn,
      maxLiveSpawns: y.max_live_spawns,
      ...(y.warm_window_minutes !== undefined ? { warmWindowMinutes: y.warm_window_minutes } : {}),
    }),
  );

export const templateIssueSchema = z.object({
  severity: z.enum(["error", "warning"]),
  file: z.enum([...TEMPLATE_FILES, "skills", "files"]),
  message: z.string(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  path: z.string().optional(),
});
export type TemplateIssue = z.infer<typeof templateIssueSchema>;

export const templateSummarySchema = z.object({
  name: z.string(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  runtime: z.enum(["docker", "local"]).optional(),
  errors: z.number().int(),
  warnings: z.number().int(),
  agentCount: z.number().int(),
  imageStatus: imageStatusSchema.optional(),
});
export const templatesListSchema = z.object({
  dir: z.string(),
  templates: z.array(templateSummarySchema),
});
export const templateFileStateSchema = z.object({
  file: templateFileSchema,
  content: z.string().nullable(),
  hash: z.string().nullable(),
});
export const templateDetailSchema = z.object({
  name: z.string(),
  path: z.string(),
  config: templateConfigSchema.optional(),
  files: z.array(templateFileStateSchema),
  issues: z.array(templateIssueSchema),
  agents: z.array(z.string()),
  imageStatus: imageStatusSchema.optional(),
});
export type TemplateDetail = z.infer<typeof templateDetailSchema>;
export const templateDetailResponseSchema = z.object({ template: templateDetailSchema });
export const createTemplateBodySchema = z.object({
  name: nameSchema,
  displayName: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
});
export const putTemplateFileBodySchema = z.object({
  content: z.string().max(512 * 1024),
  baseHash: z.string().nullable(),
});
export const putTemplateFileResponseSchema = z.object({
  hash: z.string(),
  issues: z.array(templateIssueSchema),
});
export const validateTemplateBodySchema = z.object({
  file: templateFileSchema,
  content: z.string().max(512 * 1024),
});
export const issuesResponseSchema = z.object({ issues: z.array(templateIssueSchema) });
