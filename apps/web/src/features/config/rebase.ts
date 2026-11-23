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

const own = (o: Rec | undefined, k: string): unknown =>
  o && Object.hasOwn(o, k) ? o[k] : undefined;

type Kind = "list" | "record" | "value";
const kind = (v: unknown): Kind | undefined =>
  v === undefined ? undefined : Array.isArray(v) ? "list" : isRec(v) ? "record" : "value";
const emptyOf = (k: Kind): unknown => (k === "list" ? [] : {});
const isEmpty = (v: unknown) =>
  (Array.isArray(v) && v.length === 0) || (isRec(v) && Object.keys(v).length === 0);

function merge3(b: unknown, m: unknown, t: unknown, path: string[], conflicts: string[]): unknown {
  const cb = canonicalJson(b);
  const cm = canonicalJson(m);
  if (cm === cb) return t;
  const ct = canonicalJson(t);
  if (ct === cb || ct === cm) return m;
  // The form prunes an emptied list and its emptied parents (setAt), so an absent side is the empty container of the
  // kind the others hold: removing the last item is then a set remove, and an add under a pruned parent still merges.
  const kinds = new Set([kind(b), kind(m), kind(t)]);
  kinds.delete(undefined);
  const [only] = kinds;
  if (kinds.size === 1 && only !== "value" && only !== undefined && !atomic(path)) {
    const fill = (v: unknown) => (v === undefined ? emptyOf(only) : v);
    const out =
      only === "list"
        ? mergeSet(fill(b) as unknown[], fill(m) as unknown[], fill(t) as unknown[])
        : mergeRecords(fill(b) as Rec, fill(m) as Rec, fill(t) as Rec, path, conflicts);
    // A merge that leaves a container empty prunes it, as the form would; the root stays an object.
    return path.length > 0 && isEmpty(out) ? undefined : out;
  }
  conflicts.push(path.join("."));
  return m;
}

function mergeRecords(b: Rec, m: Rec, t: Rec, path: string[], conflicts: string[]): Rec {
  const keys = new Set([...Object.keys(t), ...Object.keys(m)]);
  const out: [string, unknown][] = [];
  for (const k of keys) {
    const v = merge3(own(b, k), own(m, k), own(t, k), [...path, k], conflicts);
    if (v !== undefined) out.push([k, v]);
  }
  // fromEntries defines own properties: a "__proto__" key stays a key.
  return Object.fromEntries(out);
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
