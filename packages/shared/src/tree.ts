import type { ReportsTo } from "./agents.ts";

export interface TreeRow {
  slug: string;
  displayName: string;
  reportsTo: ReportsTo;
}

/**
 * Depth-first from the roots (agents whose manager is a human or isn't in `rows`), siblings by display name. A human
 * manager is no node of the tree: its reports are roots.
 */
export function treeOrder(rows: TreeRow[]): { slug: string; depth: number }[] {
  const bySlug = new Set(rows.map((r) => r.slug));
  const children = new Map<string | null, TreeRow[]>();
  for (const r of rows) {
    const parent =
      r.reportsTo.kind === "agent" && bySlug.has(r.reportsTo.handle) ? r.reportsTo.handle : null;
    children.set(parent, [...(children.get(parent) ?? []), r]);
  }
  const out: { slug: string; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    const kids = [...(children.get(parent) ?? [])].sort(
      (a, b) => a.displayName.localeCompare(b.displayName) || a.slug.localeCompare(b.slug),
    );
    for (const k of kids) {
      out.push({ slug: k.slug, depth });
      walk(k.slug, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}
