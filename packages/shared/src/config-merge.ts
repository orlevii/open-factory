import type { AgentOverlay, ConfigDoc } from "./config.ts";
import { sha256Hex } from "./sha256.ts";

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** JSON with object keys sorted at every depth, so equal values give equal strings. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (isObj(v))
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

/** The overlay's version: derived, never stored. */
export const overlayVersion = (o: AgentOverlay): string => sha256Hex(canonicalJson(o));

export const emptyDoc = (): ConfigDoc => ({ template: {}, settings: {}, mcp: { mcpServers: {} } });

/**
 * I2 §7.2: the derived key under a doc's `template` holding the template's `skills/` folder names, so adding or
 * removing a folder moves the doc (its hash, its change lines). It never comes from or goes to template.yaml.
 */
export const LOCAL_SKILL_NAMES = "local_skill_names";

/** A doc's `template` part without the derived keys: what template.yaml holds, for a strict parse or a write. */
export function yamlPart(template: Record<string, unknown>): Record<string, unknown> {
  const { [LOCAL_SKILL_NAMES]: _derived, ...yaml } = template;
  return yaml;
}

function deepMerge(a: unknown, b: unknown): unknown {
  if (b === undefined) return structuredClone(a);
  if (Array.isArray(a) && Array.isArray(b)) {
    const seen = new Set(a.map(canonicalJson));
    const added: unknown[] = [];
    for (const x of b) {
      const key = canonicalJson(x);
      if (!seen.has(key)) {
        seen.add(key);
        added.push(structuredClone(x));
      }
    }
    return [...structuredClone(a), ...added];
  }
  if (isObj(a) && isObj(b)) {
    const out: Record<string, unknown> = structuredClone(a);
    // defineProperty: a plain assignment to an own "__proto__" key would set the prototype.
    for (const [k, v] of Object.entries(b))
      Object.defineProperty(out, k, {
        value: Object.hasOwn(a, k) ? deepMerge(a[k], v) : structuredClone(v),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    return out;
  }
  return structuredClone(b);
}

/** Spec §5.2: objects merge, scalars from the overlay replace, arrays union, MCP servers replace whole. */
export function mergeConfig(base: ConfigDoc, o: AgentOverlay): ConfigDoc {
  return {
    template: deepMerge(base.template, o.template) as Record<string, unknown>,
    settings: deepMerge(base.settings, o.settings) as Record<string, unknown>,
    mcp: {
      mcpServers: {
        ...structuredClone(base.mcp.mcpServers),
        ...structuredClone(o.mcp?.mcpServers ?? {}),
      },
    },
  };
}
