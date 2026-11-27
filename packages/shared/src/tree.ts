import type { ReportsTo } from "./agents.ts";

export interface TreeRow {
  ref: string;
  handle: string;
  displayName: string;
  reportsTo: ReportsTo;
}

/**
 * Depth-first from the roots (agents whose manager is a human or isn't in `rows`), siblings by display name. A human
 * manager is no node of the tree: its reports are roots.
 */
export function treeOrder(rows: TreeRow[]): { ref: string; depth: number }[] {
  const refs = new Set(rows.map((r) => r.ref));
  const children = new Map<string | null, TreeRow[]>();
  for (const r of rows) {
    const parent =
      r.reportsTo.kind === "agent" && refs.has(r.reportsTo.ref) ? r.reportsTo.ref : null;
    children.set(parent, [...(children.get(parent) ?? []), r]);
  }
  const out: { ref: string; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    const kids = [...(children.get(parent) ?? [])].sort(
      (a, b) => a.displayName.localeCompare(b.displayName) || a.handle.localeCompare(b.handle),
    );
    for (const k of kids) {
      out.push({ ref: k.ref, depth });
      walk(k.ref, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}
