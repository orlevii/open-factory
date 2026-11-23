import { canonicalJson } from "@open-factory/shared";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);

/** Named entries re-apply whole: an MCP server is never merged field by field (spec §5.2). */
const atomic = (path: readonly string[]) =>
  path.length === 3 && path[0] === "mcp" && path[1] === "mcpServers";

/**
 * Re-applies my edits (`base` → `mine`) over `theirs` (spec §12.4, 409 Reload). Objects merge by key, so named
 * entries (env vars, MCP servers) re-apply by name; arrays are sets by canonical JSON, so the items I added are added
 * and the items I removed are removed, with no index paths. A conflict is the same path changed on both sides: mine
 * is kept and the path is reported.
 */
export function rebase<T>(base: T, mine: T, theirs: T): { value: T; conflicts: string[] } {
  const conflicts: string[] = [];
  const value = merge3(base, mine, theirs, [], conflicts) as T;
  return { value, conflicts };
}

function merge3(b: unknown, m: unknown, t: unknown, path: string[], conflicts: string[]): unknown {
  const cb = canonicalJson(b);
  const cm = canonicalJson(m);
  if (cm === cb) return t;
  const ct = canonicalJson(t);
  if (ct === cb || ct === cm) return m;
  if (!atomic(path)) {
    if (Array.isArray(m) && Array.isArray(t) && (b === undefined || Array.isArray(b)))
      return mergeSet(b ?? [], m, t);
    if (isRec(m) && isRec(t) && (b === undefined || isRec(b))) {
      const keys = new Set([...Object.keys(t), ...Object.keys(m)]);
      const out: [string, unknown][] = [];
      for (const k of keys) {
        const v = merge3(b?.[k], m[k], t[k], [...path, k], conflicts);
        if (v !== undefined) out.push([k, v]);
      }
      // fromEntries defines own properties: a "__proto__" key stays a key.
      return Object.fromEntries(out);
    }
  }
  conflicts.push(path.join("."));
  return m;
}

function mergeSet(b: unknown[], m: unknown[], t: unknown[]): unknown[] {
  const before = new Set(b.map(canonicalJson));
  const after = new Set(m.map(canonicalJson));
  const out = t.filter((x) => {
    const k = canonicalJson(x);
    return !(before.has(k) && !after.has(k));
  });
  const present = new Set(out.map(canonicalJson));
  for (const x of m) {
    const k = canonicalJson(x);
    if (!before.has(k) && !present.has(k)) {
      present.add(k);
      out.push(x);
    }
  }
  return out;
}
