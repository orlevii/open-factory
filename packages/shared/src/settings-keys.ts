import { isFactoryEnvName } from "./config.ts";

/**
 * Settings keys that are factory-owned or that run a command (spec §7.10). The start check refuses them in
 * agent-writable project and local settings. I2 hands this same constant to I7 as the `agent` policy's
 * default-deny list, so the two can't drift; any change here changes I7's policy too.
 */
/** The plugin keys: the factory passes its own with `--settings` and drops these from a template's settings. */
export const PLUGIN_SETTINGS_KEYS = [
  "enabledPlugins",
  "extraKnownMarketplaces",
  "syncClaudeAiPlugins",
] as const;

export const RESERVED_SETTINGS_KEYS: readonly string[] = [
  ...PLUGIN_SETTINGS_KEYS,
  "strictKnownMarketplaces",
  "permissions.defaultMode",
  "permissions.additionalDirectories",
  "claudeMdExcludes",
  "hooks",
  "statusLine",
  "fileSuggestion",
  "apiKeyHelper",
  "awsAuthRefresh",
  "awsCredentialExport",
  "gcpAuthRefresh",
  "otelHeadersHelper",
];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const hasDottedKey = (settings: Record<string, unknown>, dotted: string): boolean => {
  let cur: unknown = settings;
  for (const part of dotted.split(".")) {
    if (!isRecord(cur) || !Object.hasOwn(cur, part)) return false;
    cur = cur[part];
  }
  return true;
};

/**
 * The reserved keys a settings object sets, as dotted paths, sorted. An `env` entry counts as
 * `env.<NAME>` when `isFactoryEnvName` accepts its name.
 */
export function reservedKeysIn(settings: unknown): string[] {
  if (!isRecord(settings)) return [];
  const keys = RESERVED_SETTINGS_KEYS.filter((k) => hasDottedKey(settings, k));
  const env = isRecord(settings.env)
    ? Object.keys(settings.env)
        .filter(isFactoryEnvName)
        .map((name) => `env.${name}`)
    : [];
  return [...keys, ...env].sort();
}
