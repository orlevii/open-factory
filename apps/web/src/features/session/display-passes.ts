import type { Row } from "./rows";

const NO_CHILDREN: readonly Row[] = Object.freeze([]);

/** The rows nested under `row` (U3 §7.7): a tool call's (a subagent's) rows today; `work_group`,
 *  `subagent` and `subagent_overflow` join as they land. Every tree walk goes through this one helper,
 *  so a new kind with children is learned in one place. A leaf returns one shared empty array. */
export function childrenOf(row: Row): readonly Row[] {
  return row.kind === "tool" ? row.children : NO_CHILDREN;
}

type ErrorRow = Extract<Row, { kind: "error" }>;

const sameFailure = (a: ErrorRow, b: ErrorRow) =>
  a.event.source === b.event.source &&
  a.event.code === b.event.code &&
  a.event.message === b.event.message;

/** The seqs a row stands for beyond its own: a merged failure's (U3 §7.6). Deep links and the Jump
 *  pill read through it. */
export const heldSeqs = (row: Row): readonly number[] | undefined =>
  row.kind === "error" ? row.seqs : undefined;

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
  return mergeFailures(raw);
}
