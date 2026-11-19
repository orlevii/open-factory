import { z } from "zod";
import { hostSkillSchema, nameSchema, secretNameSchema } from "./names.ts";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const TEMPLATE_FILES = ["template.yaml", "AGENTS.md", "settings.json", "mcp.json"] as const;
export type TemplateFile = (typeof TEMPLATE_FILES)[number];
export const templateFileSchema = z.enum(TEMPLATE_FILES);

const pluginRef = z.string().regex(/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/, "Use name@marketplace.");

export const templateConfigSchema = z.object({
  name: nameSchema,
  displayName: z.string().min(1).max(80),
  description: z.string().max(500),
  runtime: z.enum(["docker", "local"]),
  image: z.string().min(1).optional(),
  permissionMode: z.enum(["auto", "bypass"]),
  model: z.string().min(1).optional(),
  effort: z.enum(EFFORTS).optional(),
  projects: z.array(nameSchema),
  skills: z.array(hostSkillSchema),
  localSkills: z.boolean(),
  plugins: z.array(pluginRef),
  secrets: z.array(secretNameSchema),
  canSpawn: z.array(nameSchema),
  maxLiveSpawns: z.number().int().min(0).max(50),
  warmWindowMinutes: z.number().int().min(1).max(1440),
});
export type TemplateConfig = z.infer<typeof templateConfigSchema>;

/** template.yaml as written (snake_case, strict), transformed into TemplateConfig. */
export const templateYamlSchema = z
  .strictObject({
    name: nameSchema,
    display_name: z.string().min(1).max(80),
    description: z.string().max(500).default(""),
    runtime: z.enum(["docker", "local"]).default("docker"),
    image: z.string().min(1).optional(),
    permission_mode: z.enum(["auto", "bypass"]).default("auto"),
    model: z.string().min(1).optional(),
    effort: z.enum(EFFORTS).optional(),
    projects: z.array(nameSchema).default([]),
    skills: z.array(hostSkillSchema).default([]),
    local_skills: z.boolean().default(true),
    plugins: z.array(pluginRef).default([]),
    secrets: z.array(secretNameSchema).default([]),
    can_spawn: z.array(nameSchema).default([]),
    max_live_spawns: z.number().int().min(0).max(50).default(5),
    warm_window_minutes: z.number().int().min(1).max(1440).default(70),
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
      warmWindowMinutes: y.warm_window_minutes,
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
