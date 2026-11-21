import { CircleAlert } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { runInstantOn } from "@/lib/run-instant";
import { arrivedSince, JumpPill } from "./jump-pill";
import type { Row } from "./rows";
import { registerTimelineRepin } from "./session-commands";
import { type StickToBottom, useStickToBottom } from "./stick-to-bottom";
import { TimelineItem } from "./timeline-item";

const NO_KEYS: ReadonlySet<string> = new Set();
/** What a toggle that resizes the timeline calls first, and what re-pins it (U3 §8.1). */
export type TimelineHandle = Pick<StickToBottom, "captureAnchor" | "expandAnchor" | "repin">;

const INTERACTIVE = "a[href],button,summary,pre,input,textarea,select,[tabindex]";

/** The only scrolling region: stick-to-bottom, Jump to latest, Load earlier with a scroll anchor,
 *  deep-link centring and tint, and one tab stop with roving focus (UI design §4.3, §7). */
export function Timeline(props: {
  ref?: Ref<TimelineHandle>;
  slug: string;
  spawned?: boolean;
  rows: Row[];
  failedIds: ReadonlySet<string>;
  interruptedEnds: ReadonlySet<number>;
  /** Rows above this seq arrived live (U3 §8.3); omitted, nothing is live. */
  liveAfter?: number;
  /** Row keys that replace something on screen: never live. */
  handedOff?: ReadonlySet<string>;
  highlightSeq?: number;
  /** A `?message=` target: lights the row that holds this envelope rather than the event's first. */
  highlightMessageId?: string;
  hasMoreBefore: boolean;
  /** Resolves true when rows were prepended. */
  onLoadEarlier(): Promise<boolean>;
  earlierError: boolean;
  footer: ReactNode;
  /** An older window (deep link): the Jump pill always shows and leaves it (U3 §8.2). */
  windowed?: boolean;
  /** The speech that arrived while windowed (the reducer counts it: those rows aren't appended). */
  newSpeech?: number;
  /** Navigates to the newest page. Stable: the pill is memoized. */
  onLeaveWindow?(): void;
}) {
  const { rows, liveAfter = Number.POSITIVE_INFINITY, handedOff = NO_KEYS } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const pillLayer = useRef<HTMLDivElement>(null);
  const centred = useRef(false);
  // The highest seq on screen when the view unpinned; undefined while pinned. A primitive, so the
  // pill's counts derive from rows (U3 §8.2) and the rows layout effect sets no state.
  const [seenSeq, setSeenSeq] = useState<number>();
  const latestRows = useRef(rows);
  latestRows.current = rows;
  const stick = useStickToBottom(scroller, log, (pinned) =>
    setSeenSeq(pinned ? undefined : maxSeq(latestRows.current)),
  );
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after every rows commit (the height changed).
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (litKey !== undefined && !centred.current) {
      centred.current = true;
      stick.unpin();
      el.querySelector("[data-highlighted]")?.scrollIntoView?.({ block: "center" });
      return;
    }
    // Pinned: the bottom, instantly (events arrive tens of times a minute). Unpinned: the anchor
    // row keeps its place, a Load earlier prepend included.
    stick.settle();
  }, [rows, litKey, stick]);

  const arrived = useMemo(() => arrivedSince(rows, seenSeq, handedOff), [rows, seenSeq, handedOff]);
  const windowed = props.windowed ?? false;
  const speech = windowed ? (props.newSpeech ?? 0) : arrived.speech;
  const other = !windowed && arrived.other;
  const onLeaveWindow = props.onLeaveWindow;
  const onJump = useCallback(
    () => (windowed ? onLeaveWindow?.() : stick.repin()),
    [windowed, onLeaveWindow, stick],
  );

  useImperativeHandle(
    props.ref,
    () => ({
      captureAnchor: stick.captureAnchor,
      expandAnchor: stick.expandAnchor,
      repin: stick.repin,
    }),
    [stick],
  );
  useEffect(() => registerTimelineRepin(props.slug, stick.repin), [props.slug, stick]);

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

  const loadEarlier = async () => {
    // The top visible row keeps its place when the earlier rows land above it.
    stick.expandAnchor();
    setLoadingEarlier(true);
    try {
      await props.onLoadEarlier();
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
    else if (e.key === "End") {
      // The last loaded row, and follow again; it never leaves a window (the pill alone does).
      go(list.length - 1);
      const layer = pillLayer.current;
      if (layer) runInstantOn(layer, stick.repin);
      else stick.repin();
    }
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
      <div ref={scroller} className="h-full overflow-y-auto px-4 py-4 md:px-6">
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
              live={row.seq > liveAfter && row.kind !== "turn_footer" && !handedOff.has(row.key)}
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
      {/* Centred on the 52rem column, not the scroller. */}
      <div ref={pillLayer} className="pointer-events-none absolute inset-x-0 bottom-3 px-4 md:px-6">
        <div className="relative max-w-[52rem]">
          <JumpPill
            shown={windowed || speech > 0 || other}
            speech={speech}
            other={other}
            windowed={windowed}
            onJump={onJump}
          />
        </div>
      </div>
    </div>
  );
}

/** A plain loop: rows are seq-ordered, but a group keeps its first child's seq. */
function maxSeq(rows: Row[]): number {
  let max = 0;
  for (const r of rows) if (r.seq > max) max = r.seq;
  return max;
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
export function targetRowKey(rows: Row[], seq: number): string | undefined {
  return (
    rows.find((r) => r.seq === seq)?.key ??
    rows.find((r) => r.kind === "tool" && containsSeq(r.children, seq))?.key ??
    rows.find((r) => r.seq > seq)?.key ??
    rows.at(-1)?.key
  );
}
