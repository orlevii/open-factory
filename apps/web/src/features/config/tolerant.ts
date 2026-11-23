/**
 * Tolerant readers (spec §12.2): the form renders from whatever the draft holds, which Raw JSON may have made any
 * JSON. A wrongly typed value reads as `{ ok: false }` and its field shows "Edit this in Raw JSON."; nothing throws.
 */

type Rec = Record<string, unknown>;
export const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);

export type Read = { ok: true; value: unknown } | { ok: false };
const BAD = { ok: false } as const;

/** The value at `path`. Absent containers read as absent; a container that isn't an object is wrong. */
export function readAt(root: unknown, path: readonly string[]): Read {
  let cur: unknown = root;
  for (const k of path) {
    if (cur === undefined || cur === null) return { ok: true, value: undefined };
    if (!isRec(cur)) return BAD;
    cur = Object.hasOwn(cur, k) ? cur[k] : undefined;
  }
  return { ok: true, value: cur };
}

const EMPTY: readonly string[] = [];

/** A list of strings. A valid list comes back by reference, so memoised rows keep their props. */
export function readList(r: Read): { ok: true; items: readonly string[] } | { ok: false } {
  if (!r.ok) return BAD;
  if (r.value === undefined) return { ok: true, items: EMPTY };
  if (Array.isArray(r.value) && r.value.every((x) => typeof x === "string"))
    return { ok: true, items: r.value as string[] };
  return BAD;
}

export function readString(r: Read): { ok: true; value: string | undefined } | { ok: false } {
  if (!r.ok) return BAD;
  if (r.value === undefined || typeof r.value === "string") return { ok: true, value: r.value };
  return BAD;
}

export function readNumber(r: Read): { ok: true; value: number | undefined } | { ok: false } {
  if (!r.ok) return BAD;
  if (r.value === undefined) return { ok: true, value: undefined };
  if (typeof r.value === "number" && Number.isFinite(r.value)) return { ok: true, value: r.value };
  return BAD;
}

const empty = (v: unknown) =>
  v === undefined ||
  (Array.isArray(v) && v.length === 0) ||
  (isRec(v) && Object.keys(v).length === 0);

/** A copy of `o` with `k` set in place (or removed for `undefined`). fromEntries defines own keys: "__proto__" stays a key. */
function withKey(o: Rec, k: string, v: unknown): Rec {
  const entries = Object.entries(o).filter(([key]) => key !== k || v !== undefined);
  const at = entries.findIndex(([key]) => key === k);
  if (v !== undefined) {
    if (at < 0) entries.push([k, v]);
    else entries[at] = [k, v];
  }
  return Object.fromEntries(entries);
}

const own = (o: Rec, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);

/**
 * An immutable set that keeps every other key, unknown ones included. `undefined` or an empty list removes the key,
 * and a container left empty is removed too, unless `keep(containerPath)` says it stays (a template doc's parts).
 */
export function setAt(
  root: unknown,
  path: readonly string[],
  value: unknown,
  keep: (containerPath: readonly string[]) => boolean = () => false,
): Rec {
  const go = (node: unknown, i: number): unknown => {
    const k = path[i] as string;
    const obj = isRec(node) ? node : {};
    if (i === path.length - 1) return withKey(obj, k, empty(value) ? undefined : value);
    const child = go(own(obj, k), i + 1);
    const drop = empty(child) && !keep(path.slice(0, i + 1));
    return withKey(obj, k, drop ? undefined : child);
  };
  return go(root, 0) as Rec;
}
