import type { AgentSummary, PrincipalItem } from "@open-factory/shared";

/** The agent fields a mention reads (from the cached live agents list). */
export type MentionAgent = Pick<
  AgentSummary,
  | "ref"
  | "handle"
  | "displayName"
  | "reportsTo"
  | "template"
  | "avatarVersion"
  | "color"
  | "archivedAt"
> & { terminatedAt?: string | undefined };

/** Before `@`: the start, or not a letter, digit, `_`, `/`, `.` or `@` (an email or a path never opens
 *  it, as the tag scanner never reads one); then the handle typed so far, up to the caret. */
const AT_TOKEN = /(?:^|[^\p{L}\p{N}_/.@])@([A-Za-z0-9-]*)$/u;

/** Where an `@` menu opens for this caret: the `@`'s index and the handle typed after it. */
export function mentionOpensAt(text: string, caret: number) {
  const m = AT_TOKEN.exec(text.slice(0, caret));
  if (!m) return undefined;
  const query = m[1] ?? "";
  return { query, from: caret - query.length - 1 };
}

const HANDLE_TAIL = /^[A-Za-z0-9-]*/;

/** The handle token becomes `@handle `: through the end of the handle, even with the caret inside it,
 *  and an existing space after it is reused, not doubled. */
export function acceptMention(text: string, handle: string, from: number, caret: number) {
  const end = caret + (HANDLE_TAIL.exec(text.slice(caret))?.[0].length ?? 0);
  const rest = text.slice(end);
  const insert = `@${handle}${rest.startsWith(" ") ? "" : " "}`;
  return {
    text: text.slice(0, from) + insert + rest,
    caret: from + insert.length + (rest.startsWith(" ") ? 1 : 0),
  };
}

const isWordStart = (name: string, q: string) =>
  name.startsWith(q) || name.split(/[\s_-]+/).some((w) => w.startsWith(q));

/** 0 a prefix match (the handle, or a word of the name), 1 a match inside either, -1 none. */
function matchClass(p: PrincipalItem, q: string): number {
  if (!q) return 0;
  const name = p.name.toLowerCase();
  if (p.handle.startsWith(q) || isWordStart(name, q)) return 0;
  return p.handle.includes(q) || name.includes(q) ? 1 : -1;
}

const NO_HANDLES: ReadonlySet<string> = new Set();

/**
 * U3 §13.4: the live principals (ended ones are never offered) other than you. Prefix matches
 * first; within them your recent senders (newest first), then your reports, then everyone
 * alphabetically by name.
 */
export function rankMentions(
  query: string,
  principals: readonly PrincipalItem[],
  {
    me,
    recent = [],
    reports = NO_HANDLES,
  }: {
    me: string | undefined;
    /** Handles that wrote to you, newest first. */
    recent?: readonly string[];
    /** Handles of the agents that report to you. */
    reports?: ReadonlySet<string>;
  },
): PrincipalItem[] {
  const q = query.toLowerCase();
  const recentAt = new Map<string, number>();
  for (const s of recent) if (!recentAt.has(s)) recentAt.set(s, recentAt.size);
  const rows: { p: PrincipalItem; cls: number; tier: number; order: number }[] = [];
  for (const p of principals) {
    if (p.state !== "live" || p.handle === me) continue;
    const cls = matchClass(p, q);
    if (cls < 0) continue;
    const r = recentAt.get(p.handle);
    if (r !== undefined) rows.push({ p, cls, tier: 0, order: r });
    else rows.push({ p, cls, tier: reports.has(p.handle) ? 1 : 2, order: 0 });
  }
  rows.sort(
    (a, b) =>
      a.cls - b.cls ||
      a.tier - b.tier ||
      a.order - b.order ||
      a.p.name.localeCompare(b.p.name) ||
      a.p.handle.localeCompare(b.p.handle),
  );
  return rows.map((r) => r.p);
}
