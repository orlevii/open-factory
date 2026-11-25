import { type AgentStatus, type TreeRow, treeOrder } from "@open-factory/shared";

export type TreeNode = { slug: string; level: number; parent: string | null; hasChildren: boolean };

export const INDENT_PX = 8;
export const MAX_INDENT_LEVEL = 4;
export const indentOf = (level: number) => Math.min(level, MAX_INDENT_LEVEL) * INDENT_PX;

export function buildTree(rows: TreeRow[]): TreeNode[] {
  const order = treeOrder(rows);
  const parents = new Set(rows.map((r) => r.slug));
  const parentOf = new Map(
    rows.map((r) => [
      r.slug,
      r.reportsTo.kind === "agent" && parents.has(r.reportsTo.handle) ? r.reportsTo.handle : null,
    ]),
  );
  const withChildren = new Set<string>();
  for (const p of parentOf.values()) if (p) withChildren.add(p);
  return order.map(({ slug, depth }) => ({
    slug,
    level: depth,
    parent: parentOf.get(slug) ?? null,
    hasChildren: withChildren.has(slug),
  }));
}

/** Roots start open, the rest closed; a stored toggle overrides; a revealed slug (an ancestor of the active agent) is forced open. */
export const isExpanded = (
  node: TreeNode,
  stored: Record<string, boolean>,
  revealed: ReadonlySet<string>,
): boolean => revealed.has(node.slug) || (stored[node.slug] ?? node.level === 0);

export function visibleNodes(
  nodes: TreeNode[],
  stored: Record<string, boolean>,
  revealed: ReadonlySet<string>,
): TreeNode[] {
  const bySlug = new Map(nodes.map((n) => [n.slug, n]));
  const open = new Map<string, boolean>();
  const shown = (n: TreeNode): boolean => {
    if (!n.parent) return true;
    const parent = bySlug.get(n.parent) as TreeNode;
    return shown(parent) && isOpen(parent);
  };
  const isOpen = (n: TreeNode) => {
    const known = open.get(n.slug);
    if (known !== undefined) return known;
    const v = isExpanded(n, stored, revealed);
    open.set(n.slug, v);
    return v;
  };
  return nodes.filter(shown);
}

export function ancestorsOf(nodes: TreeNode[], slug: string): string[] {
  const bySlug = new Map(nodes.map((n) => [n.slug, n]));
  const out: string[] = [];
  for (let p = bySlug.get(slug)?.parent; p; p = bySlug.get(p)?.parent) out.unshift(p);
  return out;
}

/** Working descendants (any depth) of each collapsed node that has children. */
export function workingCounts(
  nodes: TreeNode[],
  statusOf: (slug: string) => AgentStatus | undefined,
  expanded: (slug: string) => boolean,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const n of nodes) {
    if (statusOf(n.slug) !== "working") continue;
    for (const a of ancestorsOf(nodes, n.slug)) counts[a] = (counts[a] ?? 0) + 1;
  }
  const out: Record<string, number> = {};
  for (const n of nodes)
    if (n.hasChildren && !expanded(n.slug) && counts[n.slug])
      out[n.slug] = counts[n.slug] as number;
  return out;
}

const BADGE_STATUSES = new Set<AgentStatus>(["working", "queued", "rate_limited", "errored"]);

/** The collapsed rail: the active agent, anyone with unread messages, anyone whose status earns a badge; tree order. */
export function railSlugs(
  nodes: TreeNode[],
  o: {
    active: string | null;
    unread: (slug: string) => number;
    statusOf: (slug: string) => AgentStatus | undefined;
  },
): string[] {
  return nodes
    .filter((n) => {
      const s = o.statusOf(n.slug);
      return (
        n.slug === o.active || o.unread(n.slug) > 0 || (s !== undefined && BADGE_STATUSES.has(s))
      );
    })
    .map((n) => n.slug);
}

export function pruneStored(
  stored: Record<string, boolean>,
  liveSlugs: Set<string>,
): Record<string, boolean> {
  return Object.fromEntries(Object.entries(stored).filter(([k]) => liveSlugs.has(k)));
}
