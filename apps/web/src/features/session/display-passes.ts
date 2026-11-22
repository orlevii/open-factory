import type { Row } from "./rows";

const NO_CHILDREN: readonly Row[] = Object.freeze([]);

/** The rows nested under `row` (U3 §7.7): a tool call's (a subagent's) rows today; `work_group`,
 *  `subagent` and `subagent_overflow` join as they land. Every tree walk goes through this one helper,
 *  so a new kind with children is learned in one place. A leaf returns one shared empty array. */
export function childrenOf(row: Row): readonly Row[] {
  return row.kind === "tool" ? row.children : NO_CHILDREN;
}

/** Step 3 of the rows pipeline (U3 §7.7): display-only passes over the stabilized raw rows. Stored rows
 *  are never touched, and a row a pass leaves alone is returned as the same object, so the second
 *  stabilization keeps it. No pass yet (`mergeFailures` lands next): the input itself. */
export function runDisplayPasses(raw: Row[]): Row[] {
  return raw;
}
