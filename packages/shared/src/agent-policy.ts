import type { AgentOverlay, ConfigDoc } from "./config.ts";
import { CONFIG_MSG, isFactoryEnvName } from "./config.ts";
import { canonicalJson, yamlPart } from "./config-merge.ts";
import type { TemplateFile, TemplateIssue } from "./templates.ts";

/**
 * What an agent may change (spec §6.3): dotted paths, `*` for any one key. Everything else in a file may be there,
 * but its value must be canonical-JSON-equal before and after (rule 1). Template-only entries are filtered for overlays.
 */
export const AGENT_EDITABLE = {
  /** `template.yaml`. */
  templateYaml: [
    "name",
    "display_name",
    "description",
    "model",
    "effort",
    "warm_window_minutes",
    "skills",
    "can_spawn",
    "secrets",
    "projects",
    "local_skills",
  ],
  /** Judged against `frozen` (rule 3), not byte-equality. */
  frozen: ["runtime", "image", "permission_mode"],
  /** An overlay's `template` part: everything I2 allows there. */
  overlayTemplate: ["model", "effort", "warm_window_minutes", "skills", "can_spawn", "secrets"],
  settings: [
    "permissions.allow",
    "permissions.ask",
    "permissions.deny",
    "autoMode.environment",
    "autoMode.soft_deny",
    "autoMode.hard_deny",
    "env.*",
  ],
  mcp: ["mcpServers.*"],
} as const satisfies Record<string, readonly string[]>;

/** Settings lists an agent can add to but never remove from (ADR 0025), by dotted path. */
export const ADD_ONLY: readonly string[] = [
  "permissions.deny",
  "permissions.ask",
  "autoMode.soft_deny",
  "autoMode.hard_deny",
];

/** The refusal sentence for a removed restriction, by list. */
const REMOVED: Record<string, string> = {
  "permissions.deny": "Deny rules can only be removed by a human.",
  "permissions.ask": "Ask rules can only be removed by a human.",
  "autoMode.soft_deny": "Restrictions can only be removed by a human.",
  "autoMode.hard_deny": "Restrictions can only be removed by a human.",
};

/**
 * Env names an agent can't set or reference (spec §6.2 rule 4), compared upper-cased. The factory-owned names
 * (`isFactoryEnvName`, which includes the `OPEN_FACTORY_` prefix) are checked beside these.
 */
export const AGENT_REFUSED_ENV = {
  names: [
    // Traffic routing and TLS: these would man-in-the-middle the API traffic and its credential.
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    // Loaders: these would run code or swap binaries before the agent's harness.
    "NODE_OPTIONS",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "BASH_ENV",
    "PATH",
  ],
  // Claude Code and the credential path (`ANTHROPIC_BASE_URL` would send the credential to any host), and the factory's own.
  prefixes: ["ANTHROPIC_", "CLAUDE_CODE_", "OPEN_FACTORY_"],
  suffixes: ["_HELPER"],
} as const satisfies {
  names: readonly string[];
  prefixes: readonly string[];
  suffixes: readonly string[];
};

/** Whether an agent may not set or reference this env name (case-insensitive). */
export function isRefusedEnv(name: string): boolean {
  const n = name.toUpperCase();
  return (
    isFactoryEnvName(n) ||
    (AGENT_REFUSED_ENV.names as readonly string[]).includes(n) ||
    AGENT_REFUSED_ENV.prefixes.some((p) => n.startsWith(p)) ||
    AGENT_REFUSED_ENV.suffixes.some((s) => n.endsWith(s))
  );
}

// A nested default (`${X:-${PATH}}`) is cut at the first `}` on purpose: Claude Code's expander doesn't expand nested defaults either.
const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** Each `${X}` / `${X:-…}` of a refused name in any string of `value`, with the path of that string. */
function referencesIn(value: unknown, path: string[]): { path: string[]; name: string }[] {
  if (typeof value === "string")
    return [...value.matchAll(REFERENCE)]
      .map((m) => m[1] as string)
      .filter(isRefusedEnv)
      .map((name) => ({ path, name }));
  if (Array.isArray(value)) return value.flatMap((v, i) => referencesIn(v, [...path, String(i)]));
  if (isRec(value)) return Object.entries(value).flatMap(([k, v]) => referencesIn(v, [...path, k]));
  return [];
}

/** The refused env names that any string inside `value` references, in order of appearance, once each. */
export const refusedReferences = (value: unknown): string[] => [
  ...new Set(referencesIn(value, []).map((r) => r.name)),
];

const LOCAL_RUNTIME = "local";

/** The one local-runtime predicate (rule 7) every write service calls for an agent actor. */
export function touchesLocalRuntime(i: {
  templateRuntime?: string;
  templateHasLocalAgents?: boolean;
  agentRuntime?: string;
  canSpawnRuntimes?: string[];
}): boolean {
  return (
    i.templateRuntime === LOCAL_RUNTIME ||
    i.templateHasLocalAgents === true ||
    i.agentRuntime === LOCAL_RUNTIME ||
    (i.canSpawnRuntimes?.includes(LOCAL_RUNTIME) ?? false)
  );
}

export const LOCAL_RUNTIME_REFUSAL =
  "Local-runtime agents and templates can only be changed by a human.";

export type AgentPolicyInput = {
  before: ConfigDoc | AgentOverlay;
  after: ConfigDoc | AgentOverlay;
  frozen?: { runtime: string; image: string | null; permission_mode: string };
  target: "template" | "overlay";
};

type Parts = { template: Rec; settings: Rec; servers: Rec; mcp: Rec };

const partsOf = (x: ConfigDoc | AgentOverlay): Parts => {
  const r = x as { template?: Rec; settings?: Rec; mcp?: Rec };
  const mcp = r.mcp ?? {};
  return {
    template: r.template ?? {},
    settings: r.settings ?? {},
    mcp,
    servers: isRec(mcp.mcpServers) ? mcp.mcpServers : {},
  };
};

const FILES: Record<"template" | "settings" | "mcp", TemplateFile> = {
  template: "template.yaml",
  settings: "settings.json",
  mcp: "mcp.json",
};

const segments = (p: string) => p.split(".");
const segMatch = (pattern: string, seg: string) => pattern === "*" || pattern === seg;

/** Whether `path` is a pattern's path or lies under it. */
const covered = (patterns: readonly string[], path: readonly string[]): boolean =>
  patterns.some((p) => {
    const q = segments(p);
    return q.length <= path.length && q.every((s, i) => segMatch(s, path[i] as string));
  });

/** Whether `path` is a proper prefix of some pattern (an allowed key could sit below it). */
const holdsPattern = (patterns: readonly string[], path: readonly string[]): boolean =>
  patterns.some((p) => {
    const q = segments(p);
    return q.length > path.length && path.every((s, i) => segMatch(q[i] as string, s));
  });

const same = (a: unknown, b: unknown): boolean =>
  a === undefined || b === undefined ? a === b : canonicalJson(a) === canonicalJson(b);

/** A child by own property only: `constructor`, `toString` and `__proto__` of a missing key read as absent. */
const own = (o: unknown, k: string): unknown =>
  isRec(o) && Object.hasOwn(o, k) ? o[k] : undefined;

const at = (root: unknown, path: readonly string[]): unknown => path.reduce<unknown>(own, root);

/**
 * Judges what an agent wants to write against what is there (spec §6.2). Pure. Any issue
 * is a refusal. It runs after the human validation, which still refuses what no actor may write.
 */
export function agentPolicyIssues(i: AgentPolicyInput): TemplateIssue[] {
  const out: TemplateIssue[] = [];
  const add = (part: keyof typeof FILES, path: string[], message: string) =>
    out.push({ severity: "error", file: FILES[part], message, path: path.join(".") });
  const before = partsOf(i.before);
  const after = partsOf(i.after);
  const isTemplate = i.target === "template";

  // Rule 1 (and 3's byte-equality fallback): off the allowlist, the value is unchanged.
  const templatePatterns: readonly string[] = isTemplate
    ? AGENT_EDITABLE.templateYaml
    : AGENT_EDITABLE.overlayTemplate;
  const settingsPatterns: readonly string[] = AGENT_EDITABLE.settings;
  const withoutFrozen = (t: Rec): Rec => {
    const y = yamlPart(t);
    if (!(isTemplate && i.frozen)) return y;
    return Object.fromEntries(
      Object.entries(y).filter(([k]) => !(AGENT_EDITABLE.frozen as readonly string[]).includes(k)),
    );
  };
  const walk = (
    part: keyof typeof FILES,
    patterns: readonly string[],
    b: unknown,
    a: unknown,
    path: string[],
  ): void => {
    if (same(b, a) || covered(patterns, path)) return;
    const objects = (b === undefined || isRec(b)) && (a === undefined || isRec(a));
    if (objects && ((b !== undefined && a !== undefined) || holdsPattern(patterns, path))) {
      const keys = new Set([...Object.keys((b as Rec) ?? {}), ...Object.keys((a as Rec) ?? {})]);
      for (const k of keys) walk(part, patterns, own(b, k), own(a, k), [...path, k]);
      return;
    }
    add(part, [part, ...path], `${[part, ...path].join(".")} can only be changed by a human.`);
  };
  walk(
    "template",
    templatePatterns,
    withoutFrozen(before.template),
    withoutFrozen(after.template),
    [],
  );
  walk("settings", settingsPatterns, before.settings, after.settings, []);
  walk("mcp", AGENT_EDITABLE.mcp, before.mcp, after.mcp, []);

  // Rule 2: restrictions are add-only.
  for (const list of ADD_ONLY) {
    const path = segments(list);
    const was = at(before.settings, path);
    if (!Array.isArray(was)) continue;
    const now = at(after.settings, path);
    const kept = new Set((Array.isArray(now) ? now : []).map(canonicalJson));
    for (const [n, item] of was.entries())
      if (!kept.has(canonicalJson(item)))
        add("settings", ["settings", ...path, String(n)], REMOVED[list] as string);
  }

  // Rule 3: the frozen boundary fields, after schema defaults.
  if (isTemplate && i.frozen) {
    const y = yamlPart(after.template);
    const now: Record<string, unknown> = {
      runtime: y.runtime ?? "docker",
      image: y.image ?? null,
      permission_mode: y.permission_mode ?? "auto",
    };
    for (const field of AGENT_EDITABLE.frozen)
      if (now[field] !== i.frozen[field])
        add("template", ["template", field], `${field} can only be changed by a human.`);
  }

  // Rule 4: env names an agent adds or changes, and references to them.
  const refuseName = (part: keyof typeof FILES, path: string[], name: string) =>
    add(part, path, `${name} can only be set by a human.`);
  const wasSecrets = new Set(Array.isArray(before.template.secrets) ? before.template.secrets : []);
  if (Array.isArray(after.template.secrets))
    for (const [n, name] of after.template.secrets.entries())
      if (typeof name === "string" && !wasSecrets.has(name) && isRefusedEnv(name))
        refuseName("template", ["template", "secrets", String(n)], name);
  const envOf = (s: Rec) => (isRec(s.env) ? s.env : {});
  for (const [name, v] of Object.entries(envOf(after.settings)))
    if (isRefusedEnv(name) && !same(own(envOf(before.settings), name), v))
      refuseName("settings", ["settings", "env", name], name);
  for (const [server, entry] of Object.entries(after.servers)) {
    const prior = own(before.servers, server);
    const env = isRec(entry) && isRec(entry.env) ? entry.env : {};
    const priorEnv = isRec(prior) && isRec(prior.env) ? prior.env : {};
    for (const [name, v] of Object.entries(env))
      if (isRefusedEnv(name) && !same(own(priorEnv, name), v))
        refuseName("mcp", ["mcp", "mcpServers", server, "env", name], name);
    if (same(prior, entry)) continue;
    const seen = new Set<string>();
    for (const ref of referencesIn(entry, ["mcp", "mcpServers", server]))
      if (!seen.has(ref.name)) {
        seen.add(ref.name);
        add("mcp", ref.path, `MCP server ${server} can't reference ${ref.name}.`);
      }
  }

  // Rule 5: the factory's own server.
  if (
    Object.hasOwn(after.servers, "factory") &&
    !same(own(before.servers, "factory"), own(after.servers, "factory"))
  )
    add("mcp", ["mcp", "mcpServers", "factory"], CONFIG_MSG.factoryServer);

  return out;
}
