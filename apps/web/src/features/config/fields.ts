/**
 * The form's fixed field ids (L4): `useFieldErrors` takes a static list, and every issue path maps to one of these.
 * Overlay and doc paths share one shape (`template.*`, `settings.*`, `mcp.mcpServers.*`), so one table serves both modes.
 */
export const CONFIG_FIELDS = [
  "model",
  "effort",
  "warmWindow",
  "skills",
  "env",
  "envSecrets",
  "canSpawn",
  "mcp",
] as const;
export type ConfigField = (typeof CONFIG_FIELDS)[number];

export const FIELD_PATHS: Readonly<Record<ConfigField, readonly string[]>> = {
  model: ["template", "model"],
  effort: ["template", "effort"],
  warmWindow: ["template", "warm_window_minutes"],
  skills: ["template", "skills"],
  env: ["settings", "env"],
  envSecrets: ["template", "secrets"],
  canSpawn: ["template", "can_spawn"],
  mcp: ["mcp", "mcpServers"],
};

const BY_PATH = new Map<string, ConfigField>(
  CONFIG_FIELDS.map((f) => [FIELD_PATHS[f].join("."), f] as const),
);

/**
 * The field an issue path belongs to, and the rest of the path under it (the item). `settings.permissions.allow.3` →
 * allow, item "3"; `mcp.mcpServers.github.env.TOKEN` → mcp, item "github.env.TOKEN". The item is the whole rest
 * because an entry name may contain dots (`ctx.io`): the field matches it against its own names. Null for a path no
 * field owns.
 */
export function fieldForPath(path: string): { field: ConfigField; item?: string } | null {
  const parts = path.split(".");
  // Field paths are two or three segments long: try the longest prefix first.
  for (const len of [3, 2]) {
    if (parts.length < len) continue;
    const field = BY_PATH.get(parts.slice(0, len).join("."));
    if (!field) continue;
    return parts.length === len ? { field } : { field, item: parts.slice(len).join(".") };
  }
  return null;
}

/** The dotted path of a field, for matching conflicts and issues. */
export const fieldPath = (f: ConfigField): string => FIELD_PATHS[f].join(".");
