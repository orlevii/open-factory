import type { Row, ToolRow } from "./rows";

const NO_CHILDREN: readonly Row[] = Object.freeze([]);

/** The rows nested under `row` (U3 §7.7): a tool call's (a subagent's) rows and a folded run's calls;
 *  `subagent` and `subagent_overflow` join as they land. Every tree walk goes through this one helper,
 *  so a new kind with children is learned in one place. A leaf returns one shared empty array. */
export function childrenOf(row: Row): readonly Row[] {
  return row.kind === "tool" || row.kind === "work_group" ? row.children : NO_CHILDREN;
}

export type WorkGroupRow = Extract<Row, { kind: "work_group" }>;

/** The key a group's first call renders under: the group itself keeps that call's key (U3 §9.4). */
export const innerKey = (key: string) => `c:${key}`;

/** A group is open while its own key or any of its calls' keys is expanded (U3 §9.4, M8): an expanded
 *  call opens the group it joins, derived here rather than written into `expanded` by an effect. */
export const groupOpen = (g: WorkGroupRow, expanded: ReadonlySet<string>): boolean =>
  expanded.has(g.key) || g.children.some((c) => expanded.has(c.key));

const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

/** Calls that fold: settled or running, never failed or denied, and not a subagent (U3 §9.4). Factory
 *  blocks are rows of their own kinds, so they end a run too. */
const foldable = (row: Row): row is ToolRow =>
  row.kind === "tool" &&
  row.state !== "failed" &&
  !row.denial &&
  !SUBAGENT_TOOLS.has(row.call.name);

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
type Family = "read" | "ran" | "edited" | "other";
const familyOf = (name: string): Family =>
  name === "Read" ? "read" : name === "Bash" ? "ran" : EDIT_TOOLS.has(name) ? "edited" : "other";

/** The file a read or an edit is about, so one file read twice counts once. */
function pathOf(row: ToolRow): string | undefined {
  const i = row.call.input as { file_path?: unknown; notebook_path?: unknown } | null;
  const p = i?.file_path ?? i?.notebook_path;
  return typeof p === "string" ? p : undefined;
}

/** "read:6,ran:4": each family in order of first appearance, with its count (files for reads and
 *  edits, calls otherwise). A flat string, so the shallow stabilization compares it. */
function verbsKeyOf(calls: readonly ToolRow[]): string {
  const seen = new Map<Family, Set<string>>();
  for (const c of calls) {
    const f = familyOf(c.call.name);
    const ids = seen.get(f) ?? new Set<string>();
    ids.add((f === "read" || f === "edited" ? pathOf(c) : undefined) ?? `#${c.key}`);
    seen.set(f, ids);
  }
  return [...seen].map(([f, ids]) => `${f}:${ids.size}`).join(",");
}

function workGroup(calls: ToolRow[], newest: boolean): WorkGroupRow {
  const first = calls[0] as ToolRow;
  const last = calls.at(-1) as ToolRow;
  const ms = last.resultAt ? Date.parse(last.resultAt) - Date.parse(first.at) : Number.NaN;
  return {
    kind: "work_group",
    key: first.key,
    seq: first.seq,
    children: [{ ...first, key: innerKey(first.key) }, ...calls.slice(1)],
    verbsKey: verbsKeyOf(calls),
    callCount: calls.length,
    ...(ms >= 0 ? { durationMs: ms } : {}),
    // The run can still grow: nothing follows it, and no call lost its turn (a turn's end always
    // appends a row: its footer, an error line or the exit).
    live: newest && calls.every((c) => c.state !== "no_result"),
  };
}

/**
 * Two or more consecutive foldable top-level calls become one `work_group` row keyed by the first
 * call (U3 §9.4), so the wrapper persists when a run grows from one call to two (no remount, no fade).
 * Any other row ends a run. The calls are the stabilized raw rows themselves, except the first, copied
 * under its inner key (the second stabilization gives the copy back its identity). Nothing to fold
 * returns `rows` itself.
 */
export function groupWork(rows: Row[]): Row[] {
  let out: Row[] | undefined;
  let i = 0;
  while (i < rows.length) {
    let j = i;
    while (j < rows.length && foldable(rows[j] as Row)) j++;
    if (j - i >= 2) {
      out ??= rows.slice(0, i);
      out.push(workGroup(rows.slice(i, j) as ToolRow[], j === rows.length));
      i = j;
    } else {
      const end = Math.max(j, i + 1);
      if (out) for (let k = i; k < end; k++) out.push(rows[k] as Row);
      i = end;
    }
  }
  return out ?? rows;
}

type ErrorRow = Extract<Row, { kind: "error" }>;

const sameFailure = (a: ErrorRow, b: ErrorRow) =>
  a.event.source === b.event.source &&
  a.event.code === b.event.code &&
  a.event.message === b.event.message;

const groupSeqs = new WeakMap<Row, readonly number[]>();

/** The seqs a row stands for beyond its own: a merged failure's (U3 §7.6) and a folded run's calls
 *  (§9.4), first to last. Deep links and the Jump pill read through it. */
export function heldSeqs(row: Row): readonly number[] | undefined {
  if (row.kind === "error") return row.seqs;
  if (row.kind !== "work_group") return undefined;
  let seqs = groupSeqs.get(row);
  if (!seqs) {
    seqs = row.children.map((c) => c.seq);
    groupSeqs.set(row, seqs);
  }
  return seqs;
}

/**
 * Adjacent `error` rows with the same source, code and message become one row keyed by the first
 * occurrence, with `count`, `lastAt` and `seqs` (U3 §7.6). The key and `seq` stay the first's, so a
 * new repeat never remounts the row or fades it in (§8.3). Stored rows are untouched: a merged row is
 * a new object (the second stabilization keeps it while nothing changes). Nothing to merge returns
 * `rows` itself.
 */
export function mergeFailures(rows: Row[]): Row[] {
  let out: Row[] | undefined;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as Row;
    const prev = out?.at(-1) ?? (i > 0 ? rows[i - 1] : undefined);
    if (row.kind === "error" && prev?.kind === "error" && sameFailure(prev, row)) {
      out ??= rows.slice(0, i);
      const first = out.pop() as ErrorRow;
      out.push({
        ...first,
        count: (first.count ?? 1) + 1,
        lastAt: row.at,
        seqs: [...(first.seqs ?? [first.seq]), row.seq],
      });
    } else out?.push(row);
  }
  return out ?? rows;
}

/** Step 3 of the rows pipeline (U3 §7.7): display-only passes over the stabilized raw rows. Stored rows
 *  are never touched, and a row a pass leaves alone is returned as the same object, so the second
 *  stabilization keeps it. */
export function runDisplayPasses(raw: Row[]): Row[] {
  return mergeFailures(groupWork(raw));
}
