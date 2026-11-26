import type { InboxItem } from "@open-factory/shared";
import {
  hashKey,
  type InfiniteData,
  type QueryClient,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import type { CompletionItem, CompletionSource } from "@/components/composer/composer";
import {
  acceptMention,
  type Mention,
  type MentionAgent,
  type MentionHuman,
  mentionOpensAt,
  rankMentions,
} from "@/components/composer/mentions";
import { inboxQueryKey } from "@/features/inbox/api";
import { agentsListQueryOptions } from "@/features/session/api";
import { usersQueryOptions } from "@/features/settings/api";
import { sessionQueryOptions } from "@/lib/session";

// The `@` source over the app's query cache. It lives in features (not components/composer, which
// keeps the pure matching and ranking) because it reads the inbox, agents, users and session data.

/** The users list is refreshed at most this often by an opening menu. */
const USERS_STALE_MS = 60_000;
const NO_AGENTS: MentionAgent[] = [];
const NO_HUMANS: MentionHuman[] = [];
type InboxPage = {
  items: Pick<InboxItem, "from" | "createdAt">[];
  chats?: { agent: { handle: string }; latest: { createdAt: string } }[] | undefined;
};

/** Agents that wrote to you, newest first: your unread chats and the newest inbox items (a read of whatever
 *  the inbox already loaded). */
function recentSenders(qc: QueryClient): string[] {
  const pages = qc.getQueryData<InfiniteData<InboxPage>>(inboxQueryKey)?.pages ?? [];
  const found: { handle: string; at: string }[] = [];
  for (const p of pages) {
    for (const i of p.items)
      if (i.from.kind === "agent") found.push({ handle: i.from.handle, at: i.createdAt });
    for (const c of p.chats ?? []) found.push({ handle: c.agent.handle, at: c.latest.createdAt });
  }
  return found.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).map((f) => f.handle);
}

const toItem = (m: Mention): CompletionItem => ({
  id: m.handle,
  label: m.name,
  detail: `@${m.handle}`,
  group: m.kind === "agent" ? "agents" : "humans",
  ...(m.kind === "agent"
    ? {
        avatar: {
          agentRef: m.ref,
          template: m.template,
          avatarVersion: m.avatarVersion,
          color: m.color,
        },
      }
    : {}),
});

/**
 * The `@` source over the query cache (review notes M3, m11): `items(query)` reads the agents, users,
 * session and inbox data already cached when the menu asks (only while it is open), so nothing is
 * fetched per keystroke and no list frame renders the composer while the menu is closed. Task comments and the session both
 * insert `@handle ` (U3 §13.4).
 */
export function mentionSource(qc: QueryClient, label: string): CompletionSource {
  return {
    trigger: "@",
    label,
    opensAt: mentionOpensAt,
    items: (query) =>
      rankMentions(query, {
        agents:
          qc.getQueryData<MentionAgent[]>(agentsListQueryOptions("exclude").queryKey) ?? NO_AGENTS,
        humans: qc.getQueryData<MentionHuman[]>(usersQueryOptions.queryKey) ?? NO_HUMANS,
        me: qc.getQueryData(sessionQueryOptions.queryKey)?.user.handle,
        recent: recentSenders(qc),
      }).map(toItem),
    accept: (item, text, from, caret) => acceptMention(text, item.id, from, caret),
    // While the menu is open: the users list loads once if nobody cached it (a task page visited
    // first), and a change to either list re-reads the rows, so late data shows without a keystroke.
    watch(onChange) {
      void qc.prefetchQuery({ ...usersQueryOptions, staleTime: USERS_STALE_MS });
      const watched = new Set([
        hashKey(usersQueryOptions.queryKey),
        hashKey(agentsListQueryOptions("exclude").queryKey),
      ]);
      return qc.getQueryCache().subscribe((e) => {
        if (e.type === "updated" && e.action.type === "success" && watched.has(e.query.queryHash))
          onChange();
      });
    },
  };
}

/** One `@` source per query client: identity-stable, so it never breaks the composer's `memo`. */
export function useMentionSource(label: string): CompletionSource {
  const qc = useQueryClient();
  return useMemo(() => mentionSource(qc, label), [qc, label]);
}
