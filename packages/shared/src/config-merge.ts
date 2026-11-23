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
    for (const [k, v] of Object.entries(b))
      out[k] = k in a ? deepMerge(a[k], v) : structuredClone(v);
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
