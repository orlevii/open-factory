import { ArrowDown, CircleAlert } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import type { Row } from "./rows";
import { TimelineItem } from "./timeline-item";

const NEAR_BOTTOM = 64;
const INTERACTIVE = "a[href],button,summary,pre,input,textarea,select,[tabindex]";

/** The only scrolling region: stick-to-bottom, "N new events", Load earlier with a scroll anchor,
 *  deep-link centring and tint, and one tab stop with roving focus (UI design §4.3, §7). */
export function Timeline(props: {
  slug: string;
  spawned?: boolean;
  rows: Row[];
  failedIds: ReadonlySet<string>;
  interruptedEnds: ReadonlySet<number>;
  highlightSeq?: number;
  /** A `?message=` target: lights the row that holds this envelope rather than the event's first. */
  highlightMessageId?: string;
  hasMoreBefore: boolean;
  /** Resolves true when rows were prepended. */
  onLoadEarlier(): Promise<boolean>;
  earlierError: boolean;
  footer: ReactNode;
}) {
  const { rows } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prevLastKey = useRef<string | undefined>(undefined);
  const anchor = useRef<{ height: number; top: number; firstKey?: string } | null>(null);
  const centred = useRef(false);
  const [unseen, setUnseen] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [activeKey, setActiveKey] = useState<string | undefined>();
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [highlight, setHighlight] = useState(props.highlightSeq);
  const litKey = useMemo(
    () =>
      highlight === undefined
        ? undefined
        : (props.highlightMessageId !== undefined &&
            rows.find((r) => rowHasMessage(r, props.highlightMessageId as string))?.key) ||
          targetRowKey(rows, highlight),
    [rows, highlight, props.highlightMessageId],
  );

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const prevIndex = rows.findIndex((r) => r.key === prevLastKey.current);
    const appended = prevIndex < 0 ? 0 : rows.length - 1 - prevIndex;
    prevLastKey.current = rows.at(-1)?.key;
    const a = anchor.current;
    if (a && rows[0]?.key !== a.firstKey) {
      // Load earlier prepended: keep the first visible row where it was.
      el.scrollTop = a.top + (el.scrollHeight - a.height);
      anchor.current = null;
      return;
    }
    if (litKey !== undefined && !centred.current) {
      centred.current = true;
      atBottom.current = false;
      el.querySelector("[data-highlighted]")?.scrollIntoView?.({ block: "center" });
      return;
    }
    if (atBottom.current)
      el.scrollTop = el.scrollHeight; // instant: events arrive tens of times a minute
    else if (appended > 0) setUnseen((n) => n + appended);
  }, [rows, litKey]);

  // Footer and async content (queued blocks, the Working line, highlighting, "Show all") change the
  // height without changing rows: stay pinned while at the bottom.
  useEffect(() => {
    const el = scroller.current;
    const content = log.current;
    if (!el || !content || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (atBottom.current && !anchor.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  // The tint stays until the user clicks somewhere other than the highlighted row.
  useEffect(() => {
    if (highlight === undefined) return;
    const onPointerDown = (e: PointerEvent) => {
      const lit = scroller.current?.querySelector("[data-highlighted]");
      if (!lit?.contains(e.target as Node)) setHighlight(undefined);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [highlight]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
    if (atBottom.current) setUnseen(0);
  };

  const loadEarlier = async () => {
    const el = scroller.current;
    if (el) anchor.current = { height: el.scrollHeight, top: el.scrollTop, firstKey: rows[0]?.key };
    setLoadingEarlier(true);
    try {
      if (!(await props.onLoadEarlier())) anchor.current = null; // nothing prepended
    } finally {
      setLoadingEarlier(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const active = document.activeElement as HTMLElement | null;
    if (!active) return;
    if (e.key === "Escape" && !active.hasAttribute("data-row")) {
      const row = active.closest<HTMLElement>("[data-row]");
      if (row) {
        e.preventDefault();
        row.focus();
      }
      return;
    }
    if (!active.hasAttribute("data-row")) return;
    if (e.key === "Enter" && !active.matches("button,summary")) {
      const inner = active.querySelector<HTMLElement>("a[href],button,summary,input");
      if (inner) {
        e.preventDefault();
        inner.focus();
      }
      return;
    }
    const list = [...(log.current?.querySelectorAll<HTMLElement>("[data-row]") ?? [])];
    const i = list.indexOf(active);
    const go = (n: number) => {
      e.preventDefault();
      list[Math.max(0, Math.min(list.length - 1, n))]?.focus();
    };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(list.length - 1);
  };

  // Roving tabindex: exactly one row is in the tab order; the first row until one is focused.
  const tabKey =
    activeKey !== undefined && hasKey(rows, activeKey, expanded) ? activeKey : rows[0]?.key;
  // One tab stop (UI design §5, §7): links, buttons and scrollable plates inside a row are in the tab
  // order only while that row is the focused one (tabindex 0), so Tab walks its controls and then
  // leaves; every other row's controls are -1. Rows and Copy link manage their own tabindex.
  // Work is proportional to the change (spec §9.7): the whole log once on mount, then only the nodes
  // React adds, and on a tab-row change only the previous and the new tab row.
  const tabKeyRef = useRef(tabKey);
  const applyTo = useCallback((root: Element) => {
    const sel = `[data-row-wrap] :is(${INTERACTIVE})`;
    const set = (el: HTMLElement) => {
      if (el.hasAttribute("data-row") || el.hasAttribute("data-copy-link")) return;
      // Only a row's own content counts; the Copy link actions and tool plates stay at -1.
      const owner = el.closest<HTMLElement>("[data-row]");
      el.setAttribute("tabindex", owner?.dataset.row === tabKeyRef.current ? "0" : "-1");
    };
    if (root instanceof HTMLElement && root.matches(sel)) set(root);
    for (const el of root.querySelectorAll<HTMLElement>(sel)) set(el);
  }, []);
  useEffect(() => {
    const content = log.current;
    if (!content) return;
    applyTo(content);
    // Only added nodes need a tabindex pass: nothing flips a control's interactivity in place.
    const mo = new MutationObserver((records) => {
      for (const rec of records)
        for (const n of rec.addedNodes) if (n instanceof HTMLElement) applyTo(n);
    });
    mo.observe(content, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [applyTo]);
  useLayoutEffect(() => {
    const prev = tabKeyRef.current;
    if (prev === tabKey) return;
    tabKeyRef.current = tabKey;
    const content = log.current;
    if (!content) return;
    for (const key of [prev, tabKey]) {
      if (key === undefined) continue;
      const row = content.querySelector(`[data-row="${CSS.escape(key)}"]`);
      if (row) applyTo(row);
    }
  }, [tabKey, applyTo]);
  const onRowFocus = useCallback((k: string) => setActiveKey(k), []);
  const toggle = useCallback(
    (k: string) =>
      setExpanded((s) => {
        const n = new Set(s);
        if (n.has(k)) n.delete(k);
        else n.add(k);
        return n;
      }),
    [],
  );

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto px-4 py-4 md:px-6">
        <div
          ref={log}
          role="log"
          aria-label="Session"
          aria-live="off"
          onKeyDown={onKeyDown}
          className="max-w-[52rem] min-w-0 space-y-3"
        >
          {props.hasMoreBefore && (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={loadEarlier} disabled={loadingEarlier}>
                {loadingEarlier ? "Loading…" : "Load earlier"}
              </Button>
              {props.earlierError && (
                <span className="flex items-center gap-1.5 text-[0.8125rem] leading-[1.125rem]">
                  <CircleAlert aria-hidden="true" className="size-3.5 shrink-0 text-destructive" />
                  Couldn't load earlier events.
                </span>
              )}
            </div>
          )}
          {rows.map((row, i) => (
            <TimelineItem
              key={row.key}
              row={row}
              slug={props.slug}
              spawned={props.spawned}
              lit={row.key === litKey}
              firstOfSeq={rows[i - 1]?.seq !== row.seq}
              tabKey={tabKey}
              expanded={expanded}
              failedIds={props.failedIds}
              interruptedEnds={props.interruptedEnds}
              toggle={toggle}
              onRowFocus={onRowFocus}
            />
          ))}
          {props.footer}
        </div>
      </div>
      {unseen > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="absolute right-4 bottom-3 border border-border bg-card md:right-6"
          onClick={() => {
            const el = scroller.current;
            if (el) el.scrollTop = el.scrollHeight;
            atBottom.current = true;
            setUnseen(0);
          }}
        >
          <ArrowDown aria-hidden="true" /> {unseen} new {unseen === 1 ? "event" : "events"}
        </Button>
      )}
    </div>
  );
}

/** Only rows that are mounted: children of collapsed tools are not. */
const hasKey = (rows: Row[], key: string, expanded: ReadonlySet<string>): boolean =>
  rows.some(
    (r) =>
      r.key === key ||
      (r.kind === "tool" && expanded.has(r.key) && hasKey(r.children, key, expanded)),
  );

/** True when the row shows the envelope (or one of its merged ids / parts). */
function rowHasMessage(row: Row, id: string): boolean {
  const has = (e: { id: string; ids?: string[]; parts?: { id: string }[] }) =>
    e.id === id || !!e.ids?.includes(id) || !!e.parts?.some((p) => p.id === id);
  if (row.kind === "message") return has(row.message);
  if (row.kind === "update_group") return row.envelopes.some(has);
  if (row.kind === "peer") return has(row.envelope);
  return false;
}

const containsSeq = (rows: Row[], seq: number): boolean =>
  rows.some((r) => r.seq === seq || (r.kind === "tool" && containsSeq(r.children, seq)));

/** The row a deep link lands on: its own row, else the tool row holding it, else the nearest later
 *  row (hidden events such as `usage` have none), else the last row. */
function targetRowKey(rows: Row[], seq: number): string | undefined {
  return (
    rows.find((r) => r.seq === seq)?.key ??
    rows.find((r) => r.kind === "tool" && containsSeq(r.children, seq))?.key ??
    rows.find((r) => r.seq > seq)?.key ??
    rows.at(-1)?.key
  );
}
