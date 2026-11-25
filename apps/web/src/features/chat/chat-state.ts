import type { ChatEntry, ChatPage } from "@open-factory/shared";
import type { InfiniteData } from "@tanstack/react-query";

/** The infinite chat query's data: the newest page first, each older one after it; a page's entries
 *  run oldest first (I1 §6.3). */
export type ChatData = InfiniteData<ChatPage, string>;

/** An entry's identity across refetches and optimistic sends (I1 §6.4): a message by its
 *  `clientMessageId` when it has one, else its id; an outcome by the batch it ended (the working
 *  line's key, so the outcome and the working line are one node). */
export function entryKey(e: ChatEntry): string {
  return e.kind === "message" ? (e.clientMessageId ?? e.id) : `turn:${e.key}`;
}

const timeOf = (e: ChatEntry) => Date.parse(e.kind === "message" ? e.createdAt : e.endedAt);

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) =>
    jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/**
 * Entries the cache holds plus entries just fetched, by key (I1 §6.5): a fetched entry equal to its
 * cached one keeps the cached object (so memoised rows skip), a changed one replaces it, a cached one
 * the fetch lacks stays (a refetch of the newest page never drops older rows), a new one is placed by
 * time (stable among equals). Returns `cached` itself when nothing changed.
 */
export function unionEntries(
  cached: readonly ChatEntry[],
  fetched: readonly ChatEntry[],
): readonly ChatEntry[] {
  const byKey = new Map<string, ChatEntry>();
  for (const e of cached) byKey.set(entryKey(e), e);
  let changed = false;
  for (const e of fetched) {
    const k = entryKey(e);
    const had = byKey.get(k);
    if (had && jsonEqual(had, e)) continue;
    byKey.set(k, e);
    changed = true;
  }
  if (!changed && byKey.size === cached.length) return cached;
  const merged = [...byKey.values()];
  // Entries arrive in order; only a late one (a pending row that was delivered, a backfill) needs a place.
  for (let i = 1; i < merged.length; i++) {
    if (timeOf(merged[i - 1] as ChatEntry) > timeOf(merged[i] as ChatEntry)) {
      merged.sort((a, b) => timeOf(a) - timeOf(b));
      break;
    }
  }
  return merged;
}

/** Whether a fetched page reaches the cached newest entries (or the start of the thread), so nothing
 *  lies between it and the cache. */
export function meetsCache(page: ChatPage, cached: ChatPage | undefined): boolean {
  if (!cached || page.nextCursor === null) return true;
  const have = new Set(cached.entries.map(entryKey));
  return page.entries.some((e) => have.has(entryKey(e)));
}

const sameWorking = (a: ChatPage["working"], b: ChatPage["working"]) =>
  a === b || (a !== null && b !== null && a.key === b.key && a.since === b.since);

/**
 * Writes freshly fetched newest pages (newest first; more than one when a gap larger than a page
 * opened between the cache and now) through the union. The newest cached page grows to hold them and
 * keeps its `nextCursor`, so Load earlier still continues from the same place. Every object that did
 * not change keeps its identity, the data object included.
 */
export function mergeNewest(prev: ChatData | undefined, fetched: readonly ChatPage[]): ChatData {
  const newest = fetched[0] as ChatPage;
  if (!prev || prev.pages.length === 0) return { pages: [newest], pageParams: [""] };
  const head = prev.pages[0] as ChatPage;
  let entries: readonly ChatEntry[] = head.entries;
  // Oldest fetched page first: each lands between the cache and the newer pages.
  for (let i = fetched.length - 1; i >= 0; i--)
    entries = unionEntries(entries, (fetched[i] as ChatPage).entries);
  const working = sameWorking(head.working, newest.working) ? head.working : newest.working;
  if (entries === head.entries && working === head.working && head.newerCursor === null)
    return prev;
  const page: ChatPage = {
    entries: entries as ChatEntry[],
    nextCursor: head.nextCursor,
    newerCursor: null,
    working,
  };
  return { pages: [page, ...prev.pages.slice(1)], pageParams: prev.pageParams };
}

/** What the view reads from the pages: every entry once, oldest first, and the newest page's working
 *  line. Entries are the pages' own objects. */
export type ChatThread = {
  entries: ChatEntry[];
  working: ChatPage["working"];
  /** Older entries exist (the oldest page has a cursor). */
  hasEarlier: boolean;
  /** The pages end before the thread's newest entry (an `around` window). */
  windowed: boolean;
};

export function flattenPages(data: ChatData): ChatThread {
  const pages = data.pages;
  const first = pages[0];
  const last = pages[pages.length - 1];
  let entries: readonly ChatEntry[] = [];
  // Oldest page first. A single page is its own list: no copy, no dedupe.
  if (pages.length === 1) entries = first?.entries ?? [];
  else
    for (let i = pages.length - 1; i >= 0; i--)
      entries = unionEntries(entries, pages[i]?.entries ?? []);
  return {
    entries: entries as ChatEntry[],
    working: first?.working ?? null,
    hasEarlier: last?.nextCursor != null,
    windowed: first?.newerCursor != null,
  };
}

export const keysOf = (entries: readonly ChatEntry[]): ReadonlySet<string> =>
  new Set(entries.map(entryKey));

/**
 * The keys that arrived live (I1 §6.4): an agent's message the cursor didn't hold. Never your own
 * (its optimistic block is the same node), a pending row turning delivered (same key, already held),
 * or an outcome that replaces the working line the view showed (`workingKey`).
 */
export function liveKeys(
  entries: readonly ChatEntry[],
  cursor: ReadonlySet<string>,
  workingKey: string | undefined,
): ReadonlySet<string> {
  const live = new Set<string>();
  for (const e of entries) {
    const k = entryKey(e);
    if (cursor.has(k)) continue;
    if (e.kind === "message" ? e.fromKind === "agent" : e.key !== workingKey) live.add(k);
  }
  return live;
}

/** Your message as the composer put it in the cache, before the server's row (same `clientMessageId`)
 *  replaced it: its id is the client's own. */
export const isSending = (e: ChatEntry): boolean =>
  e.kind === "message" && e.clientMessageId !== undefined && e.id === e.clientMessageId;

/** The data without one optimistic entry (a send that failed); the data itself when it isn't there,
 *  or the server's row has taken its place. */
export function withoutSending(data: ChatData, key: string): ChatData {
  const head = data.pages[0];
  if (!head?.entries.some((e) => isSending(e) && entryKey(e) === key)) return data;
  const page: ChatPage = {
    ...head,
    entries: head.entries.filter((e) => !(isSending(e) && entryKey(e) === key)),
  };
  return { ...data, pages: [page, ...data.pages.slice(1)] };
}

/** Consecutive messages from one sender at most this far apart share a speaker line. */
export const GROUP_WINDOW_MS = 5 * 60_000;

/**
 * Whether `e` continues the speaker line of the entry before it: both messages from the same sender
 * to the same recipients, at most five minutes apart, `e` not urgent (its badge lives on a speaker
 * line). Anything between them (an outcome, a divider, a cancelled message) is the caller's to check.
 */
export function continuesGroup(prev: ChatEntry | undefined, e: ChatEntry): boolean {
  if (prev?.kind !== "message" || e.kind !== "message" || e.urgent) return false;
  if (prev.from !== e.from || prev.fromKind !== e.fromKind) return false;
  if (prev.recipients.join("\n") !== e.recipients.join("\n")) return false;
  const gap = Date.parse(e.createdAt) - Date.parse(prev.createdAt);
  return gap >= 0 && gap <= GROUP_WINDOW_MS;
}
