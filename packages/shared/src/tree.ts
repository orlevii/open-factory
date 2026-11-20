export interface TreeRow {
  slug: string;
  displayName: string;
  reportsTo: string | null;
}

/** Depth-first from the roots (agents whose manager isn't in `rows`), siblings by display name. */
export function treeOrder(rows: TreeRow[]): { slug: string; depth: number }[] {
  const bySlug = new Set(rows.map((r) => r.slug));
  const children = new Map<string | null, TreeRow[]>();
  for (const r of rows) {
    const parent = r.reportsTo && bySlug.has(r.reportsTo) ? r.reportsTo : null;
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
