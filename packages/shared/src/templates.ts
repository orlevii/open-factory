import { z } from "zod";
import { MSG } from "./messages.ts";
import { modelSchema } from "./models.ts";
import { hostSkillSchema, nameSchema, secretNameSchema } from "./names.ts";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const TEMPLATE_FILES = ["template.yaml", "AGENTS.md", "settings.json", "mcp.json"] as const;
export type TemplateFile = (typeof TEMPLATE_FILES)[number];
export const templateFileSchema = z.enum(TEMPLATE_FILES);

// The Docker image reference grammar (distribution/reference): `[registry[:port]/]path[:tag][@algo:hex]`.
const domainPart = "(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])";
const pathPart = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
const IMAGE_REF = new RegExp(
  `^(?:${domainPart}(?:\\.${domainPart})*(?::[0-9]+)?/)?${pathPart}(?:/${pathPart})*` +
    "(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?" +
    // Only the digest Docker accepts: a malformed one is a validation error, not a Docker 400.
    "(?:@sha256:[0-9a-f]{64})?$",
);
/** An image reference only (no `..`, whitespace, `?` or `#`): it reaches Docker API paths that aren't encoded. */
export const imageRefSchema = z
  .string()
  .max(255)
  .regex(IMAGE_REF, "Use a Docker image reference, like ghcr.io/org/image:tag.");

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
  secrets: z.array(secretNameSchema),
  canSpawn: z.array(nameSchema),
  maxLiveSpawns: z.number().int().min(0).max(50),
  warmWindowMinutes: z.number().int().min(1).max(1440).optional(),
});
export type TemplateConfig = z.infer<typeof templateConfigSchema>;

/**
 * The field schemas of template.yaml, with no defaults and no transform. The overlay (config.ts) picks from
 * this shape; a default would fill `skills: []` into every overlay.
 */
export const templateYamlShape = {
  name: nameSchema,
  display_name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  runtime: z.enum(["docker", "local"]).optional(),
  image: imageRefSchema.optional(),
  permission_mode: z.enum(["auto", "bypass"]).optional(),
  model: modelSchema.optional(),
  effort: z.enum(EFFORTS).optional(),
  projects: z.array(nameSchema).max(200).optional(),
  skills: z.array(hostSkillSchema).max(200).optional(),
  local_skills: z.boolean().optional(),
  secrets: z.array(secretNameSchema).max(200).optional(),
  can_spawn: z.array(nameSchema).max(200).optional(),
  max_live_spawns: z.number().int().min(0).max(50).optional(),
  warm_window_minutes: z.number().int().min(1).max(1440).optional(),
};

/** template.yaml as written (snake_case, strict), transformed into TemplateConfig. */
export const templateYamlSchema = z
  .strictObject({
    ...templateYamlShape,
    description: templateYamlShape.description.default(""),
    runtime: templateYamlShape.runtime.default("docker"),
    permission_mode: templateYamlShape.permission_mode.default("auto"),
    projects: templateYamlShape.projects.default([]),
    skills: templateYamlShape.skills.default([]),
    local_skills: templateYamlShape.local_skills.default(true),
    secrets: templateYamlShape.secrets.default([]),
    can_spawn: templateYamlShape.can_spawn.default([]),
    max_live_spawns: templateYamlShape.max_live_spawns.default(5),
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
  /** U2 §15.3: the folder's `avatar.svg` version (null when absent or rejected) and whether it is over 256 KB. */
  avatar: z.object({ version: z.string().nullable(), tooLarge: z.boolean() }),
});
export type TemplateDetail = z.infer<typeof templateDetailSchema>;
export const templateDetailResponseSchema = z.object({ template: templateDetailSchema });
/** U2 §14: the web's static route beside `/templates/$name` (`/templates/new`). A template
 *  with this name would be unreachable by URL, so creation refuses it. */
export const RESERVED_TEMPLATE_NAMES: readonly string[] = ["new"];
export const isReservedTemplateName = (name: string) => RESERVED_TEMPLATE_NAMES.includes(name);
export const createTemplateBodySchema = z.object({
  name: nameSchema.refine((n) => !isReservedTemplateName(n), MSG.nameReserved),
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
