import type { ConfigDoc } from "./config.ts";
import { canonicalJson } from "./config-merge.ts";

/**
 * Secret-safe change lines (spec §7.2). Values appear only for model, effort, image, permission mode,
 * numbers, and permission rules; env vars, MCP servers and unknown settings keys show a name and a kind.
 */

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
const rec = (v: unknown): Rec => (isRec(v) ? v : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** One line only: a value with a newline would split a notice. */
const oneLine = (s: string): string => s.replace(/\s*[\r\n]+\s*/g, " ");
const shown = (v: unknown): string =>
  typeof v === "string" || typeof v === "number"
    ? oneLine(String(v))
    : v === undefined
      ? "default"
      : "set";

const SCALARS: readonly (readonly [key: string, label: string, unit?: string])[] = [
  ["model", "model"],
  ["effort", "effort"],
  ["warm_window_minutes", "warm window", " min"],
  ["max_live_spawns", "max live spawns"],
  ["image", "image"],
  ["permission_mode", "permission mode"],
];

/** `withValue` lists show the item (a name or a rule); a trust note shows nothing. */
function listLines(
  a: unknown,
  b: unknown,
  label: string,
  opts: { value?: "plain" | "code" | "none"; prefix?: boolean } = {},
): string[] {
  const { value = "plain", prefix = false } = opts;
  const side = (v: unknown) => new Map(list(v).map((x) => [canonicalJson(x), x] as const));
  const before = side(a);
  const after = side(b);
  const render = (x: unknown): string => {
    if (value === "none" || typeof x !== "string") return "";
    return value === "code" ? ` \`${oneLine(x)}\`` : ` ${oneLine(x)}`;
  };
  const out: string[] = [];
  for (const [k, x] of after)
    if (!before.has(k))
      out.push(prefix ? `${label}: added${render(x)}` : `added ${label}${render(x)}`);
  for (const [k, x] of before)
    if (!after.has(k))
      out.push(prefix ? `${label}: removed${render(x)}` : `removed ${label}${render(x)}`);
  return out;
}

/** Names that differ between two records: only the name and the kind of change, never a value. */
function namedLines(a: Rec, b: Rec, label: string): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(b)) {
    if (!(k in a)) out.push(`${label} ${oneLine(k)} added`);
    else if (canonicalJson(a[k]) !== canonicalJson(v)) out.push(`${label} ${oneLine(k)} changed`);
  }
  for (const k of Object.keys(a)) if (!(k in b)) out.push(`${label} ${oneLine(k)} removed`);
  return out;
}

const withoutKeys = (r: Rec, keys: readonly string[]): Rec =>
  Object.fromEntries(Object.entries(r).filter(([k]) => !keys.includes(k)));

const PERMISSION_LISTS = ["allow", "deny"] as const;
const AUTO_LISTS = ["environment", "soft_deny", "hard_deny"] as const;

/** One line per change between two effective configs, sorted. `[]` when nothing a running agent sees changed. */
export function describeChanges(a: ConfigDoc, b: ConfigDoc): string[] {
  const out: string[] = [];
  const ta = rec(a.template);
  const tb = rec(b.template);

  for (const [key, label, unit = ""] of SCALARS)
    if (canonicalJson(ta[key]) !== canonicalJson(tb[key]))
      out.push(`${label}: ${shown(ta[key])} → ${shown(tb[key])}${unit}`);
  const skillsOn = (t: Rec) => t.local_skills !== false;
  if (skillsOn(ta) !== skillsOn(tb)) out.push(`template skills ${skillsOn(tb) ? "on" : "off"}`);

  out.push(...listLines(ta.skills, tb.skills, "skill"));
  out.push(...listLines(ta.plugins, tb.plugins, "plugin"));
  out.push(...listLines(ta.secrets, tb.secrets, "secret"));
  out.push(...listLines(ta.can_spawn, tb.can_spawn, "can spawn", { prefix: true }));
  out.push(...listLines(ta.local_skill_names, tb.local_skill_names, "template skill"));

  const sa = rec(a.settings);
  const sb = rec(b.settings);
  const pa = rec(sa.permissions);
  const pb = rec(sb.permissions);
  out.push(...listLines(pa.allow, pb.allow, "allow rule", { value: "code" }));
  out.push(...listLines(pa.deny, pb.deny, "deny rule", { value: "code" }));
  const ma = rec(sa.autoMode);
  const mb = rec(sb.autoMode);
  out.push(...listLines(ma.environment, mb.environment, "trust note", { value: "none" }));
  out.push(...listLines(ma.soft_deny, mb.soft_deny, "deny rule", { value: "code" }));
  out.push(...listLines(ma.hard_deny, mb.hard_deny, "deny rule", { value: "code" }));

  out.push(...namedLines(rec(sa.env), rec(sb.env), "env"));
  out.push(...namedLines(rec(a.mcp?.mcpServers), rec(b.mcp?.mcpServers), "MCP server"));

  // Every other settings key, and what is left of `permissions` and `autoMode` after their lists above.
  const rest = (s: Rec, p: Rec, m: Rec): Rec => ({
    ...withoutKeys(s, ["permissions", "autoMode", "env"]),
    permissions: withoutKeys(p, PERMISSION_LISTS),
    autoMode: withoutKeys(m, AUTO_LISTS),
  });
  const ra = rest(sa, pa, ma);
  const rb = rest(sb, pb, mb);
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  for (const k of keys) {
    const empty = (v: unknown) => isRec(v) && Object.keys(v).length === 0;
    const va = empty(ra[k]) ? undefined : ra[k];
    const vb = empty(rb[k]) ? undefined : rb[k];
    if (canonicalJson(va) !== canonicalJson(vb)) out.push(`settings key ${oneLine(k)} changed`);
  }

  return out.sort();
}

type Kind = { test: RegExp; label: string; plural?: string };
/** Collections show a count ("2 rules"); scalars show only their name. */
const KINDS: readonly Kind[] = [
  { test: /^(added|removed) skill /, label: "skill", plural: "skills" },
  { test: /^(added|removed) plugin /, label: "plugin", plural: "plugins" },
  { test: /^(added|removed) secret /, label: "secret", plural: "secrets" },
  { test: /^(added|removed) (allow|deny) rule/, label: "rule", plural: "rules" },
  { test: /^(added|removed) trust note/, label: "trust note", plural: "trust notes" },
  { test: /^(added|removed) template skill /, label: "template skill", plural: "template skills" },
  { test: /^can spawn: /, label: "can spawn" },
  { test: /^env /, label: "env var", plural: "env vars" },
  { test: /^MCP server /, label: "MCP server", plural: "MCP servers" },
  { test: /^settings key /, label: "settings key", plural: "settings keys" },
  { test: /^template skills (on|off)$/, label: "template skills" },
];

const kindOf = (line: string): string =>
  KINDS.find((k) => k.test.test(line))?.label ?? line.split(": ", 1)[0] ?? line;

/** "model, 1 skill, 2 rules and 3 more": at most three kinds, in line order, then the count of the rest. */
export function summarizeChanges(lines: string[]): string {
  const counts = new Map<string, number>();
  for (const l of lines) counts.set(kindOf(l), (counts.get(kindOf(l)) ?? 0) + 1);
  const parts = [...counts].map(([label, n]) => {
    const kind = KINDS.find((k) => k.label === label);
    return kind?.plural ? `${n} ${n === 1 ? label : kind.plural}` : label;
  });
  const shownParts = parts.slice(0, 3).join(", ");
  const more = parts.length - 3;
  return more > 0 ? `${shownParts} and ${more} more` : shownParts;
}
