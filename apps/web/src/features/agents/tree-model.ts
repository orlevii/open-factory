import { type AgentStatus, type TreeRow, treeOrder } from "@open-factory/shared";

export type TreeNode = { ref: string; level: number; parent: string | null; hasChildren: boolean };

export const INDENT_PX = 8;
export const MAX_INDENT_LEVEL = 4;
export const indentOf = (level: number) => Math.min(level, MAX_INDENT_LEVEL) * INDENT_PX;

export function buildTree(rows: TreeRow[]): TreeNode[] {
  const order = treeOrder(rows);
  const parents = new Set(rows.map((r) => r.ref));
  const parentOf = new Map(
    rows.map((r) => [
      r.ref,
      r.reportsTo.kind === "agent" && parents.has(r.reportsTo.ref) ? r.reportsTo.ref : null,
    ]),
  );
  const withChildren = new Set<string>();
  for (const p of parentOf.values()) if (p) withChildren.add(p);
  return order.map(({ ref, depth }) => ({
    ref,
    level: depth,
    parent: parentOf.get(ref) ?? null,
    hasChildren: withChildren.has(ref),
  }));
}

/** Roots start open, the rest closed; a stored toggle overrides; a revealed ref (an ancestor of the active agent) is forced open. */
export const isExpanded = (
  node: TreeNode,
  stored: Record<string, boolean>,
  revealed: ReadonlySet<string>,
): boolean => revealed.has(node.ref) || (stored[node.ref] ?? node.level === 0);

export function visibleNodes(
  nodes: TreeNode[],
  stored: Record<string, boolean>,
  revealed: ReadonlySet<string>,
): TreeNode[] {
  const byRef = new Map(nodes.map((n) => [n.ref, n]));
  const open = new Map<string, boolean>();
  const shown = (n: TreeNode): boolean => {
    if (!n.parent) return true;
    const parent = byRef.get(n.parent) as TreeNode;
    return shown(parent) && isOpen(parent);
  };
  const isOpen = (n: TreeNode) => {
    const known = open.get(n.ref);
    if (known !== undefined) return known;
    const v = isExpanded(n, stored, revealed);
    open.set(n.ref, v);
    return v;
  };
  return nodes.filter(shown);
}

export function ancestorsOf(nodes: TreeNode[], ref: string): string[] {
  const byRef = new Map(nodes.map((n) => [n.ref, n]));
  const out: string[] = [];
  for (let p = byRef.get(ref)?.parent; p; p = byRef.get(p)?.parent) out.unshift(p);
  return out;
}

/** Working descendants (any depth) of each collapsed node that has children. */
export function workingCounts(
  nodes: TreeNode[],
  statusOf: (ref: string) => AgentStatus | undefined,
  expanded: (ref: string) => boolean,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const n of nodes) {
    if (statusOf(n.ref) !== "working") continue;
    for (const a of ancestorsOf(nodes, n.ref)) counts[a] = (counts[a] ?? 0) + 1;
  }
  const out: Record<string, number> = {};
  for (const n of nodes)
    if (n.hasChildren && !expanded(n.ref) && counts[n.ref]) out[n.ref] = counts[n.ref] as number;
  return out;
}

const BADGE_STATUSES = new Set<AgentStatus>(["working", "queued", "rate_limited", "errored"]);

/** The collapsed rail: the active agent, anyone with unread messages, anyone whose status earns a badge; tree order. */
export function railRefs(
  nodes: TreeNode[],
  o: {
    active: string | null;
    unread: (ref: string) => number;
    statusOf: (ref: string) => AgentStatus | undefined;
  },
): string[] {
  return nodes
    .filter((n) => {
      const s = o.statusOf(n.ref);
      return (
        n.ref === o.active || o.unread(n.ref) > 0 || (s !== undefined && BADGE_STATUSES.has(s))
      );
    })
    .map((n) => n.ref);
}

export function pruneStored(
  stored: Record<string, boolean>,
  liveRefs: Set<string>,
): Record<string, boolean> {
  return Object.fromEntries(Object.entries(stored).filter(([k]) => liveRefs.has(k)));
}
