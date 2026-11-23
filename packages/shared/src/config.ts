import { z } from "zod";
import { secretNameSchema } from "./names.ts";
import { templateIssueSchema, templateYamlShape } from "./templates.ts";

/** Overlay limits (spec §5.1). Templates get the same limits on these keys. */
export const OVERLAY_LIMITS = {
  bytes: 256 * 1024,
  item: 1000,
  value: 32 * 1024,
  listItems: 200,
  mcpServers: 50,
} as const;

export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Env names the factory sets itself: an overlay or template can never override them (spec §5.1). */
export const FACTORY_ENV_NAMES: readonly string[] = [
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
];
const FACTORY_ENV_PREFIX = "OPEN_FACTORY_";
export const isFactoryEnvName = (name: string): boolean =>
  FACTORY_ENV_NAMES.includes(name) || name.startsWith(FACTORY_ENV_PREFIX);

/** Constant messages only: a message never carries a value (spec §7.2). Each is at most 40 characters. */
export const CONFIG_MSG = {
  unknownField: "Unknown field.",
  noMarketplaces: "Not allowed in an overlay.",
  noDefaultMode: "Set in the template, not here.",
  envName: "Use letters, digits and underscores.",
  factoryEnv: "Set by the factory.",
  factoryServer: "That server name is reserved.",
  tooManyServers: "At most 50 MCP servers.",
  tooManyItems: "At most 200 items.",
  itemTooLong: "At most 1,000 characters per item.",
  valueTooLong: "At most 32 KB per value.",
  overlayTooLarge: "At most 256 KB in total.",
} as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A strict object whose unknown-key issue is a custom issue with a constant message. Zod's own
 * `unrecognized_keys` issue carries the raw keys, and a key can be a pasted secret.
 */
const strict = <T extends z.ZodRawShape>(shape: T) =>
  z
    .unknown()
    .superRefine((v, ctx) => {
      if (isRecord(v) && Object.keys(v).some((k) => !(k in shape)))
        ctx.addIssue({ code: "custom", message: CONFIG_MSG.unknownField });
    })
    .pipe(z.object(shape));

/** The overlay's `template` part: only these keys, each optional and default-free. */
export const overlayTemplateSchema = strict({
  model: templateYamlShape.model,
  effort: templateYamlShape.effort,
  warm_window_minutes: templateYamlShape.warm_window_minutes,
  max_live_spawns: templateYamlShape.max_live_spawns,
  skills: templateYamlShape.skills,
  plugins: templateYamlShape.plugins,
  can_spawn: templateYamlShape.can_spawn,
  secrets: z
    .array(secretNameSchema.refine((n) => !isFactoryEnvName(n), CONFIG_MSG.factoryEnv))
    .max(OVERLAY_LIMITS.listItems)
    .optional(),
});

const byteLength = (s: string): number => new TextEncoder().encode(s).length;

/** Applies the list and value limits to every array and string inside a JSON value. */
const checkLimits = (
  v: unknown,
  path: (string | number)[],
  ctx: z.RefinementCtx,
  inList = false,
) => {
  if (typeof v === "string") {
    const max = inList ? OVERLAY_LIMITS.item : OVERLAY_LIMITS.value;
    if (byteLength(v) > max)
      ctx.addIssue({
        code: "custom",
        path,
        message: inList ? CONFIG_MSG.itemTooLong : CONFIG_MSG.valueTooLong,
      });
  } else if (Array.isArray(v)) {
    if (v.length > OVERLAY_LIMITS.listItems)
      ctx.addIssue({ code: "custom", path, message: CONFIG_MSG.tooManyItems });
    else for (const [i, x] of v.entries()) checkLimits(x, [...path, i], ctx, true);
  } else if (isRecord(v)) {
    for (const [k, x] of Object.entries(v)) checkLimits(x, [...path, k], ctx);
  }
};

const settingsSchema = z.record(z.string(), z.unknown()).superRefine((s, ctx) => {
  if ("extraKnownMarketplaces" in s)
    ctx.addIssue({
      code: "custom",
      path: ["extraKnownMarketplaces"],
      message: CONFIG_MSG.noMarketplaces,
    });
  const perms = s.permissions;
  if (isRecord(perms) && "defaultMode" in perms)
    ctx.addIssue({
      code: "custom",
      path: ["permissions", "defaultMode"],
      message: CONFIG_MSG.noDefaultMode,
    });
  if (isRecord(s.env))
    for (const name of Object.keys(s.env)) {
      if (!ENV_NAME.test(name))
        ctx.addIssue({ code: "custom", path: ["env", name], message: CONFIG_MSG.envName });
      else if (isFactoryEnvName(name))
        ctx.addIssue({ code: "custom", path: ["env", name], message: CONFIG_MSG.factoryEnv });
    }
  checkLimits(s, [], ctx);
});

const mcpSchema = strict({
  mcpServers: z
    .record(z.string(), z.unknown())
    .refine((m) => !("factory" in m), CONFIG_MSG.factoryServer)
    .refine((m) => Object.keys(m).length <= OVERLAY_LIMITS.mcpServers, CONFIG_MSG.tooManyServers)
    .superRefine((m, ctx) => checkLimits(m, [], ctx)),
});

/** `agents.config`: what one agent changes on top of its template. `{}` means exactly the template. */
export const agentOverlaySchema = strict({
  template: overlayTemplateSchema.optional(),
  settings: settingsSchema.optional(),
  mcp: mcpSchema.optional(),
}).superRefine((v, ctx) => {
  if (byteLength(JSON.stringify(v)) > OVERLAY_LIMITS.bytes)
    ctx.addIssue({ code: "custom", message: CONFIG_MSG.overlayTooLarge });
});
export type AgentOverlay = z.infer<typeof agentOverlaySchema>;

export const configDocSchema = z.object({
  template: z.record(z.string(), z.unknown()),
  settings: z.record(z.string(), z.unknown()),
  mcp: z.object({ mcpServers: z.record(z.string(), z.unknown()) }),
});

/** A template or an effective config as three file-shaped parts (template.yaml, settings.json, mcp.json). */
export type ConfigDoc = {
  template: Record<string, unknown>;
  settings: Record<string, unknown>;
  mcp: { mcpServers: Record<string, unknown> };
};

/** The three files a template's configuration lives in, and the hashes the editor sends back (`null`: absent). */
export const CONFIG_FILES = ["template.yaml", "settings.json", "mcp.json"] as const;
export const configHashesSchema = z.object({
  "template.yaml": z.string().nullable(),
  "settings.json": z.string().nullable(),
  "mcp.json": z.string().nullable(),
});
export type ConfigHashes = z.infer<typeof configHashesSchema>;

/**
 * `GET /api/templates/:name/config` (I2 §12.1). `doc` is null while the template has errors. `localSkills` is the
 * template's own `skills/` folder names (the agent page lists them read-only). `cantStart` counts the live agents that
 * can't start: all of them while the template has errors, else the ones whose overlay fails its schema.
 */
export const templateConfigResponseSchema = z.object({
  doc: configDocSchema.nullable(),
  hashes: configHashesSchema,
  issues: z.array(templateIssueSchema),
  localSkills: z.array(z.string()),
  agents: z.object({
    live: z.number().int(),
    archived: z.number().int(),
    cantStart: z.number().int(),
  }),
});
export type TemplateConfigResponse = z.infer<typeof templateConfigResponseSchema>;

export const putTemplateConfigBodySchema = z.object({
  doc: configDocSchema,
  baseHashes: configHashesSchema,
});
export type PutTemplateConfigBody = z.infer<typeof putTemplateConfigBodySchema>;

/** The hashes after the save, and the issues of the template as written (warnings only: an error is a 400). */
export const putTemplateConfigResponseSchema = z.object({
  hashes: configHashesSchema,
  issues: z.array(templateIssueSchema),
});
export type PutTemplateConfigResponse = z.infer<typeof putTemplateConfigResponseSchema>;

/** `GET /api/host-skills` (I2 §12.1): the folders of the host skills dir that hold a `SKILL.md`. */
export const HOST_SKILL_DESCRIPTION_MAX = 200;
export const hostSkillsResponseSchema = z.object({
  dir: z.string(),
  skills: z.array(z.object({ name: z.string(), description: z.string() })),
});
export type HostSkillsResponse = z.infer<typeof hostSkillsResponseSchema>;
