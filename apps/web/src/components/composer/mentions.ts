import type { AgentSummary } from "@open-factory/shared";

/** The agent fields a mention reads (from the cached live agents list). */
export type MentionAgent = Pick<
  AgentSummary,
  "slug" | "displayName" | "reportsTo" | "template" | "avatarVersion" | "archivedAt"
> & { terminatedAt?: string | undefined };
export type MentionHuman = { handle: string; name: string; disabledAt?: string | null };

export type Mention =
  | {
      kind: "agent";
      handle: string;
      name: string;
      template: string;
      avatarVersion: string | null;
    }
  | { kind: "human"; handle: string; name: string };

/** Before `@`: the start, or not a letter, digit, `_`, `/`, `.` or `@` (an email or a path never opens
 *  it, as `extractMentions` never reads one); then the handle typed so far, up to the caret. */
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
function matchClass(m: Mention, q: string): number {
  if (!q) return 0;
  const name = m.name.toLowerCase();
  if (m.handle.startsWith(q) || isWordStart(name, q)) return 0;
  return m.handle.includes(q) || name.includes(q) ? 1 : -1;
}

/**
 * U3 §13.4: live agents (archived and terminated ones never), and the enabled humans other than
 * you. Prefix matches first; within them your recent senders (newest first), then your reports
 * (the reporting line's roots, which answer to the humans, and any agent reporting to you), then
 * everyone alphabetically by name.
 */
export function rankMentions(
  query: string,
  {
    agents,
    humans,
    me,
    recent = [],
  }: {
    agents: readonly MentionAgent[];
    humans: readonly MentionHuman[];
    me: string | undefined;
    /** Agent slugs that wrote to you, newest first. */
    recent?: readonly string[];
  },
): Mention[] {
  const q = query.toLowerCase();
  const recentAt = new Map<string, number>();
  for (const s of recent) if (!recentAt.has(s)) recentAt.set(s, recentAt.size);
  const rows: { m: Mention; cls: number; tier: number; order: number }[] = [];
  const add = (m: Mention, tier: number, order = 0) => {
    const cls = matchClass(m, q);
    if (cls >= 0) rows.push({ m, cls, tier, order });
  };
  for (const a of agents) {
    if (a.archivedAt || a.terminatedAt) continue;
    const m: Mention = {
      kind: "agent",
      handle: a.slug,
      name: a.displayName || a.slug,
      template: a.template,
      avatarVersion: a.avatarVersion,
    };
    const r = recentAt.get(a.slug);
    // "Your reports": humans aren't stored as managers, so every root of the reporting line (which
    // answers to the humans) counts as yours, as does an agent whose manager is your handle. In an org
    // with several roots, each of them is "yours".
    if (r !== undefined) add(m, 0, r);
    else add(m, a.reportsTo === null || a.reportsTo === me ? 1 : 2);
  }
  for (const h of humans) {
    if (h.disabledAt || h.handle === me) continue;
    add({ kind: "human", handle: h.handle, name: h.name || h.handle }, 2);
  }
  rows.sort(
    (a, b) =>
      a.cls - b.cls ||
      a.tier - b.tier ||
      a.order - b.order ||
      a.m.name.localeCompare(b.m.name) ||
      a.m.handle.localeCompare(b.m.handle),
  );
  return rows.map((r) => r.m);
}
