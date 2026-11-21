import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { EmptyState } from "@/components/empty-state";
import { ErrorLine } from "@/components/error-line";
import { Button } from "@/components/ui/button";
import { onRowKeyDown } from "@/lib/row-nav";
import { runInstantOn } from "@/lib/run-instant";
import { sessionQueryOptions } from "@/lib/session";
import { shouldIgnore } from "@/lib/shortcuts";
import { INBOX_DWELL_MS, PREFETCH_REST_MS } from "@/lib/timing";
import { type InboxItem, prefetchPane, useInbox, useOpenItem } from "./api";
import { InboxRow } from "./inbox-row";

const plainClick = (e: MouseEvent) =>
  e.type === "click" && e.button === 0 && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey);

/** The Inbox: a plain list of links, one per message sent to the humans (and factory items), newest
 *  first. Arrow keys also move between rows; Tab reaches every row link as usual.
 *  With `onSelect` (the two-pane layout) a plain click, Enter or Space selects a row (push) and marks it
 *  read at once; `j`/`k` move the selection (replace) and mark the resting row read after INBOX_DWELL_MS. */
export function InboxList({
  selectedId,
  onSelect,
}: {
  selectedId?: string;
  onSelect?: (id: string, replace: boolean) => void;
} = {}) {
  const q = useInbox();
  const qc = useQueryClient();
  const open = useOpenItem();
  const viewer = useQuery(sessionQueryOptions).data?.user.handle;
  const items = q.data;
  const list = useRef<HTMLUListElement>(null);
  // The rows' times are relative to when the data last changed, so a selection doesn't re-render every row.
  const now = useMemo(() => (items ? new Date() : new Date(0)), [items]);
  // Read by timers when they fire, so they never act on a stale row (one read since, or gone).
  const latest = useRef(items);
  useEffect(() => {
    latest.current = items;
  }, [items]);
  const byId = (id: string) => latest.current?.find((i) => i.id === id);

  // The dwell: the row j/k rests on is read once it has been shown for INBOX_DWELL_MS.
  const dwell = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const clearDwell = useCallback(() => {
    if (dwell.current) clearTimeout(dwell.current.timer);
    dwell.current = null;
  }, []);
  useEffect(() => {
    // The selection moved some other way (a click, Back): that row's dwell no longer applies.
    if (dwell.current && dwell.current.id !== selectedId) clearDwell();
  }, [selectedId, clearDwell]);
  useEffect(() => clearDwell, [clearDwell]);

  // The neighbours' pane data, once the selection has rested.
  const index = selectedId && items ? items.findIndex((i) => i.id === selectedId) : -1;
  const prevId = index > 0 ? items?.[index - 1]?.id : undefined;
  const nextId = index >= 0 ? items?.[index + 1]?.id : undefined;
  useEffect(() => {
    if (!prevId && !nextId) return;
    const timer = setTimeout(() => {
      for (const id of [prevId, nextId]) {
        const n = id ? latest.current?.find((i) => i.id === id) : undefined;
        if (n) prefetchPane(qc, n);
      }
    }, PREFETCH_REST_MS);
    return () => clearTimeout(timer);
  }, [prevId, nextId, qc]);

  const onOpen = useCallback(
    (item: InboxItem, e: MouseEvent) => {
      if (onSelect && plainClick(e)) {
        e.preventDefault();
        clearDwell();
        onSelect(item.id, false);
      }
      open(item);
    },
    [onSelect, open, clearDwell],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const row = onRowKeyDown(e);
    if (!onSelect || !list.current) return;
    const el = list.current;
    if (row && (e.key === "j" || e.key === "k")) {
      const id = row.dataset.inboxId;
      if (!id || id === selectedId) return;
      clearDwell();
      runInstantOn(el, () => onSelect(id, true));
      dwell.current = {
        id,
        timer: setTimeout(() => {
          dwell.current = null;
          const item = byId(id);
          if (item) open(item);
        }, INBOX_DWELL_MS),
      };
      return;
    }
    // Space selects the focused row, as Enter does (the shortcuts sheet's "Select or peek row").
    if (e.key === " " && e.target instanceof HTMLAnchorElement && !shouldIgnore(e.nativeEvent)) {
      const item = byId(e.target.dataset.inboxId ?? "");
      if (!item) return;
      e.preventDefault();
      clearDwell();
      runInstantOn(el, () => onSelect(item.id, false));
      open(item);
    }
  };
  // Pending focus, set only once a fetch has settled successfully: the control that was pressed may
  // have unmounted. A row id means "the row after it" (the last row when nothing new arrived);
  // "first" is the first row. Never armed by an error, so a later refetch can't steal focus.
  const [focusAfter, setFocusAfter] = useState<string | "first" | null>(null);
  useEffect(() => {
    if (focusAfter === null) return;
    setFocusAfter(null);
    const links = [...(list.current?.querySelectorAll<HTMLElement>("a") ?? [])];
    const i =
      focusAfter === "first" ? 0 : links.findIndex((l) => l.dataset.inboxId === focusAfter) + 1;
    (links[i] ?? links.at(-1))?.focus();
  }, [focusAfter]);

  if (!items)
    return q.isError ? (
      <ErrorLine
        text="Couldn't load the inbox."
        onRetry={() =>
          void q.refetch().then((r) => {
            if (r.isSuccess) setFocusAfter("first");
          })
        }
      />
    ) : null;
  if (items.length === 0) return <EmptyState text="Nothing in your inbox." />;

  const loadEarlier = () => {
    const last = items.at(-1)?.id;
    void q.fetchNextPage().then((r) => {
      if (r.isSuccess && last !== undefined) setFocusAfter(last);
    });
  };
  return (
    <div className="grid gap-4">
      <ul
        ref={list}
        aria-label="Inbox"
        onKeyDown={onKeyDown}
        className="border-y border-border [overflow-anchor:auto]"
      >
        {items.map((item) => (
          <InboxRow
            key={item.id}
            item={item}
            now={now}
            onOpen={onOpen}
            selected={item.id === selectedId}
            selectable={onSelect !== undefined}
            viewer={viewer}
          />
        ))}
      </ul>
      {q.isFetchNextPageError ? (
        <ErrorLine text="Couldn't load earlier messages." onRetry={loadEarlier} autoFocus />
      ) : (
        q.hasNextPage && (
          <div>
            <Button variant="outline" onClick={loadEarlier} disabled={q.isFetchingNextPage}>
              Load earlier
            </Button>
          </div>
        )
      )}
    </div>
  );
}
