import type { InboxItem, PrincipalItem } from "@open-factory/shared";
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
  type MentionAgent,
  mentionOpensAt,
  rankMentions,
} from "@/components/composer/mentions";
import { inboxQueryKey } from "@/features/inbox/api";
import {
  type PrincipalsCache,
  principalsQueryOptions,
  requestPrincipal,
} from "@/features/principals/api";
import { agentsListQueryOptions } from "@/features/session/api";
import { sessionQueryOptions } from "@/lib/session";

// The `@` source over the app's query cache. It lives in features (not components/composer, which
// keeps the pure matching and ranking) because it reads the inbox, principals and session data.

const NO_AGENTS: MentionAgent[] = [];
const NO_PRINCIPALS: PrincipalItem[] = [];
type InboxPage = {
  items: Pick<InboxItem, "from" | "createdAt">[];
  chats?: { agent: { ref: string }; latest: { createdAt: string } }[] | undefined;
};

/** Refs of the agents that wrote to you, newest first: your unread chats and the newest inbox items (a read of
 *  whatever the inbox already loaded). */
function recentSenders(qc: QueryClient): string[] {
  const pages = qc.getQueryData<InfiniteData<InboxPage>>(inboxQueryKey)?.pages ?? [];
  const found: { ref: string; at: string }[] = [];
  for (const p of pages) {
    for (const i of p.items)
      if (i.from.kind === "agent") found.push({ ref: i.from.ref, at: i.createdAt });
    for (const c of p.chats ?? []) found.push({ ref: c.agent.ref, at: c.latest.createdAt });
  }
  return found.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).map((f) => f.ref);
}

const toItem = (p: PrincipalItem): CompletionItem => ({
  id: p.ref,
  label: p.name,
  detail: `@${p.handle}`,
  group: p.kind === "agent" ? "agents" : "humans",
  ...(p.avatar
    ? {
        avatar: {
          agentRef: p.ref,
          template: p.avatar.template,
          avatarVersion: p.avatar.avatarVersion,
          color: p.avatar.color,
        },
      }
    : { human: { name: p.name } }),
});

/** What the menu note says picking does; the surface that owns the composer knows. */
export type MentionNote = { note?: string };

/**
 * The `@` source over the query cache: it tags. `items(query)` ranks the live principals already cached
 * when the menu asks (only while it is open), so nothing is fetched per keystroke and no list frame
 * renders the composer while the menu is closed. A picked row is a tag range (`acceptTag`, `id` is the
 * ref), stored and sent as `<@ref>`; `tagHandle` hydrates stored tags back to `@handle`.
 */
export function mentionSource(qc: QueryClient, { note }: MentionNote = {}): CompletionSource {
  const cache = () => qc.getQueryData<PrincipalsCache>(principalsQueryOptions.queryKey);
  const principalsHash = hashKey(principalsQueryOptions.queryKey);
  return {
    trigger: "@",
    label: "Tag someone",
    opensAt: mentionOpensAt,
    items: (query) => {
      const me = qc.getQueryData(sessionQueryOptions.queryKey)?.user.ref;
      const agents = qc.getQueryData<MentionAgent[]>(agentsListQueryOptions("exclude").queryKey);
      const reports = new Set(
        (agents ?? NO_AGENTS).filter((a) => a.reportsTo.ref === me).map((a) => a.ref),
      );
      const everyone = cache()?.byRef.values();
      return rankMentions(query, everyone ? [...everyone] : NO_PRINCIPALS, {
        me,
        recent: recentSenders(qc),
        reports,
      }).map(toItem);
    },
    // The row's detail is `@handle`.
    acceptTag: (item) => ({ ref: item.id, handle: (item.detail ?? "").slice(1) }),
    accept: (item, text, from, caret) =>
      acceptMention(text, (item.detail ?? "").slice(1), from, caret),
    tagHandle(ref) {
      const found = cache()?.byRef.get(ref);
      if (found) return found.handle;
      // Not loaded yet: ask (everyone when there is no cache at all, else this ref in a batch).
      if (cache()) requestPrincipal(qc, ref);
      else void qc.prefetchQuery(principalsQueryOptions);
      return undefined;
    },
    watchTags: (onChange) =>
      qc.getQueryCache().subscribe((e) => {
        if (
          e.type === "updated" &&
          e.action.type === "success" &&
          e.query.queryHash === principalsHash
        )
          onChange();
      }),
    ...(note ? { menuNote: (rows: number) => (rows > 0 ? note : undefined) } : {}),
    // While the menu is open: the principals load once if nobody cached them, and a change to them
    // or to the agents list re-reads the rows, so late data shows without a keystroke.
    watch(onChange) {
      void qc.prefetchQuery(principalsQueryOptions);
      const watched = new Set([
        principalsHash,
        hashKey(agentsListQueryOptions("exclude").queryKey),
      ]);
      return qc.getQueryCache().subscribe((e) => {
        if (e.type === "updated" && e.action.type === "success" && watched.has(e.query.queryHash))
          onChange();
      });
    },
  };
}

/** The menu note for the fields that take a tag but aren't a message (a task title or body, a description, a schedule body). */
export const FIELD_TAG_NOTE = "Esc keeps it as text";

/** One `@` source per query client and note: identity-stable, so it never breaks the composer's `memo`. */
export function useMentionSource(opts: MentionNote = {}): CompletionSource {
  const qc = useQueryClient();
  const { note } = opts;
  return useMemo(() => mentionSource(qc, note ? { note } : {}), [qc, note]);
}
