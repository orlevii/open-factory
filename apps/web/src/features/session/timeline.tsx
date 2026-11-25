import type { SubagentProgress } from "@open-factory/shared";
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
import { readViewPosition, useRememberPosition } from "@/features/agents/view-memory";
import { useDocumentVisible } from "@/hooks/use-document-visible";
import { runInstantOn } from "@/lib/run-instant";
import { childrenOf, groupOpen, heldSeqs, innerKey, isFold } from "./display-passes";
import { arrivedSince, JumpPill } from "./jump-pill";
import { rowOf } from "./row-of";
import { type Row, textRowKey } from "./rows";
import { registerTimelineRepin } from "./session-commands";
import type { LiveText } from "./session-state";
import { type StickToBottom, useStickToBottom } from "./stick-to-bottom";
import type { RowProgress } from "./timeline-item";
import { type Arrival, rowGap, TimelineItem } from "./timeline-item";

const NO_KEYS: ReadonlySet<string> = new Set();
const NO_TEXTS: readonly LiveText[] = [];
const NO_PROGRESS: readonly SubagentProgress[] = [];
type TextRow = Extract<Row, { kind: "text" }>;
const NO_PENDING: readonly Row[] = [];
const NO_LIVE_ROWS: readonly TextRow[] = [];

/**
 * The live text blocks as rows (U3 §11.4), keyed like the persisted rows that will retire them. A
 * block's row object is kept while its text, cap and `head` are unchanged, so a frame that grows one
 * block leaves the others' items alone. `at` is when this view first saw the block (the speaker
 * line's time until the persisted row brings the server's).
 */
function useLiveRows(texts: readonly LiveText[], head: boolean, off: boolean): readonly TextRow[] {
  const prev = useRef<ReadonlyMap<string, TextRow>>(new Map());
  const rows = useMemo(() => {
    if (off || texts.length === 0) return NO_LIVE_ROWS;
    return texts.map((t, i): TextRow => {
      const key = textRowKey(t.messageId, t.index);
      // Only the first block can open a speaker line: a later one follows a text block.
      const h = i === 0 && head;
      const old = prev.current.get(key);
      if (old && old.text === t.text && old.head === h && (old.capped === true) === t.capped)
        return old;
      return {
        kind: "text",
        seq: Number.POSITIVE_INFINITY,
        at: old?.at ?? new Date().toISOString(),
        text: t.text,
        key,
        head: h,
        live: true,
        ...(t.capped ? { capped: true } : {}),
      };
    });
  }, [texts, head, off]);
  useLayoutEffect(() => {
    prev.current = new Map(rows.map((r) => [r.key, r]));
  }, [rows]);
  return rows;
}
/** What a toggle that resizes the timeline calls first, and what re-pins it (U3 §8.1). */
export type TimelineHandle = Pick<StickToBottom, "captureAnchor" | "expandAnchor" | "repin">;

/** Visible time the deep-link tint holds before it fades (U3 §7.4, Q28). */
export const ARRIVAL_MS = 2000;

/** Focuses a deep-linked row without scrolling again. A programmatic focus after a mouse navigation
 *  may not match `:focus-visible`; the row then carries `data-focus-ring`, styled the same, until it
 *  loses focus ("ring = focus"). */
export function arrive(row: HTMLElement) {
  row.focus({ preventScroll: true });
  let visible = false;
  try {
    visible = row.matches(":focus-visible");
  } catch {
    // An engine without :focus-visible: the stand-in ring.
  }
  if (visible) return;
  row.setAttribute("data-focus-ring", "");
  row.addEventListener("blur", () => row.removeAttribute("data-focus-ring"), { once: true });
}

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
  /** Raw sends without a row yet (`rawTailRows`): items after the rows, keyed like their rows. */
  pendingRows?: readonly Row[];
  /** An older window (deep link): the Jump pill always shows and leaves it (U3 §8.2). */
  windowed?: boolean;
  /** The speech that arrived while windowed (the reducer counts it: those rows aren't appended). */
  newSpeech?: number;
  /** Navigates to the newest page. Stable: the pill is memoized. */
  onLeaveWindow?(): void;
  /** `state.live.texts` (U3 §11.4): rendered after the rows, never in a windowed view. */
  liveTexts?: readonly LiveText[];
  /** The next top-level text opens a speaker line (`buildRows`' `textHead`). */
  textHead?: boolean;
  /** `state.live.subagents` (U3 §12): each card's live line, passed only to subagent rows. */
  subagents?: readonly SubagentProgress[];
}) {
  const { rows, liveAfter = Number.POSITIVE_INFINITY, handedOff = NO_KEYS } = props;
  const windowed = props.windowed ?? false;
  const liveRows = useLiveRows(props.liveTexts ?? NO_TEXTS, props.textHead ?? false, windowed);
  const scroller = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const pillLayer = useRef<HTMLDivElement>(null);
  const centred = useRef(false);
  // The highest seq on screen when the view unpinned, and the live blocks on screen then; undefined
  // while pinned. The pill's counts derive from rows (U3 §8.2) and the rows layout effect sets no state.
  const [seen, setSeen] = useState<{ seq: number; live: ReadonlySet<string> }>();
  const latestRows = useRef(rows);
  const latestLive = useRef(liveRows);
  // Before the rows layout effect below, which may unpin (deep-link centring).
  useLayoutEffect(() => {
    latestRows.current = rows;
    latestLive.current = liveRows;
  }, [rows, liveRows]);
  const stick = useStickToBottom(scroller, log, (pinned) =>
    setSeen(
      pinned
        ? undefined
        : {
            seq: maxSeq(latestRows.current),
            live: new Set(latestLive.current.map((r) => r.key)),
          },
    ),
  );
  // Where the reader left this agent's session (a Chat/Session switch remounts the view): recorded on
  // scroll, restored once the rows are in. A deep-link window is not a place worth coming back to.
  const isPinned = useCallback(() => stick.pinned.current, [stick]);
  useRememberPosition(props.slug, "session", scroller, isPinned, !windowed);
  const restored = useRef(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [activeKey, setActiveKey] = useState<string | undefined>();
  // The focused row's key and element, for the rows layout effect (refs: focus moving re-runs nothing).
  const activeKeyRef = useRef<string | undefined>(undefined);
  const focusedEl = useRef<HTMLElement | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [highlight] = useState(props.highlightSeq);
  // The deep link's path: the top-level holder first, the row it lands on last (U3 §7.4).
  const litPath = useMemo(() => {
    if (highlight === undefined) return undefined;
    const id = props.highlightMessageId;
    const byMessage = id === undefined ? undefined : rows.find((r) => rowHasMessage(r, id))?.key;
    return byMessage !== undefined ? [byMessage] : targetPath(rows, highlight);
  }, [rows, highlight, props.highlightMessageId]);
  const litKey = litPath?.[0];
  const arrivedKey = litPath?.at(-1);
  const [arrival, setArrival] = useState<Arrival>();

  // Runs after every rows commit (the height changed).
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // A focused call that joined a group left the DOM with its old row: focus moves to the group's
    // header (U3 §9.4). Only when focus was dropped, never taken from wherever it went since.
    const lost = focusedEl.current;
    if (lost && !lost.isConnected) {
      focusedEl.current = null;
      const key = activeKeyRef.current;
      const active = document.activeElement;
      const holder =
        key === undefined || (active && active !== document.body)
          ? undefined
          : rows.find((r) => isFold(r) && (r.key === key || containsKey(r, key)));
      if (holder)
        el.querySelector<HTMLElement>(`[data-row="${CSS.escape(holder.key)}"]`)?.focus({
          preventScroll: true,
        });
    }
    if (litPath !== undefined && !centred.current) {
      // Inside a group or a call's children: the holders open first, the row is reached next commit.
      const closed = litPath.slice(0, -1).filter((k) => !expanded.has(k));
      if (closed.length > 0) {
        setExpanded((s) => new Set([...s, ...closed]));
        return;
      }
      centred.current = true;
      restored.current = true;
      stick.unpin();
      const target = el.querySelector<HTMLElement>(
        `[data-row="${CSS.escape(litPath.at(-1) ?? "")}"]`,
      );
      target?.scrollIntoView?.({ block: "center" });
      if (target) arrive(target);
      setArrival("on");
      return;
    }
    if (!restored.current && rows.length > 0) {
      restored.current = true;
      const left = windowed ? undefined : readViewPosition(props.slug, "session");
      if (left && !left.pinned) {
        stick.unpin();
        el.scrollTop = left.top;
        return;
      }
    }
    // Pinned: the bottom, instantly (events arrive tens of times a minute). Unpinned: the anchor
    // row keeps its place, a Load earlier prepend included.
    stick.settle();
  }, [rows, litPath, expanded, stick, props.slug, windowed]);

  // The tint fades after 2s of visible time (U3 §7.4): hidden, the clock stops and keeps what's left.
  // An effect runs after the row painted, so the 2s start from the first frame that shows it.
  const visible = useDocumentVisible();
  const arrivalLeft = useRef(ARRIVAL_MS);
  useEffect(() => {
    if (arrival !== "on" || !visible) return;
    const start = Date.now();
    const t = setTimeout(() => setArrival("fading"), arrivalLeft.current);
    return () => {
      clearTimeout(t);
      arrivalLeft.current = Math.max(0, arrivalLeft.current - (Date.now() - start));
    };
  }, [arrival, visible]);
  const onArrivedEnd = useCallback(() => setArrival(undefined), []);

  const arrived = useMemo(
    () => arrivedSince(rows, seen?.seq, handedOff, seen?.live),
    [rows, seen, handedOff],
  );
  // A live block that started after the reader left counts as one message (U3 §8.2).
  let liveSpeech = 0;
  if (seen) for (const r of liveRows) if (!seen.live.has(r.key)) liveSpeech++;
  const speech = windowed ? (props.newSpeech ?? 0) : arrived.speech + liveSpeech;
  const other = !windowed && arrived.other;
  const onLeaveWindow = props.onLeaveWindow;
  const onJump = useCallback(() => {
    if (windowed) {
      onLeaveWindow?.();
      return;
    }
    stick.repin();
    // The pill goes inert as it hides: focus lands on the last row rather than dropping to body.
    const rowEls = log.current?.querySelectorAll<HTMLElement>("[data-row]");
    rowEls?.[rowEls.length - 1]?.focus({ preventScroll: true });
  }, [windowed, onLeaveWindow, stick]);

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
      const row = rowOf(active);
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
  // The tree walk runs when the rows, the focused key or the expansions change, never per live frame.
  const activeInRows = useMemo(
    () => activeKey !== undefined && hasKey(rows, activeKey, expanded),
    [rows, activeKey, expanded],
  );
  // The first row until one is focused; a streaming first reply in an empty log is the stop too.
  const tabKey =
    activeInRows || (activeKey !== undefined && liveRows.some((r) => r.key === activeKey))
      ? activeKey
      : (rows[0]?.key ?? liveRows[0]?.key);
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
      // A row's content and its tool body count (`rowOf`); plates that never scroll stay at -1.
      const owner = el.hasAttribute("data-plate") ? null : rowOf(el);
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
      const k = CSS.escape(key);
      // The row and, for a tool call, its body (a sibling).
      for (const el of content.querySelectorAll(`[data-row="${k}"], [data-row-body="${k}"]`))
        applyTo(el);
    }
  }, [tabKey, applyTo]);
  const onRowFocus = useCallback((k: string) => {
    activeKeyRef.current = k;
    focusedEl.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setActiveKey(k);
  }, []);
  const toggle = useCallback(
    (k: string, inner?: readonly string[]) =>
      setExpanded((s) => {
        const n = new Set(s);
        if (inner) {
          // A group (U3 §9.4): open while it or a call is (`groupOpen`), so closing it collapses its
          // calls too; opening it opens only the group.
          // A call's inner-key mirror goes too, so a stale one can't reopen a later group.
          if (n.has(k) || inner.some((c) => n.has(c)))
            for (const x of [k, ...inner, ...inner.map(innerKey)]) n.delete(x);
          else n.add(k);
          return n;
        }
        // A call's key also keys its copy as a group's first call, so an expanded call stays open
        // when it becomes one (U3 §9.4). Nothing else is keyed by the inner key.
        const open = !n.has(k);
        for (const x of k.startsWith(innerKey("")) ? [k] : [k, innerKey(k)]) {
          if (open) n.add(x);
          else n.delete(x);
        }
        return n;
      }),
    [],
  );

  const { spawned, slug, failedIds, interruptedEnds } = props;
  const progressOf = useProgressOf(props.subagents ?? NO_PROGRESS);
  // Memoized on the rows and the per-row props: a live frame reuses these element objects, so React
  // skips every persisted item (U3 §11.4, acceptance 22).
  const rowEls = useMemo(
    () =>
      rows.map((row, i) => (
        <TimelineItem
          key={row.key}
          row={row}
          slug={slug}
          spawned={spawned}
          lit={row.key === litKey}
          arrivedKey={row.key === litKey ? arrivedKey : undefined}
          arrival={row.key === litKey ? arrival : undefined}
          onArrivedEnd={onArrivedEnd}
          live={row.seq > liveAfter && row.kind !== "turn_footer" && !handedOff.has(row.key)}
          firstOfSeq={rows[i - 1]?.seq !== row.seq}
          gap={rowGap(row, rows[i - 1])}
          tabKey={tabKey}
          expanded={expanded}
          failedIds={failedIds}
          interruptedEnds={interruptedEnds}
          toggle={toggle}
          onRowFocus={onRowFocus}
          progress={progressOf(row)}
        />
      )),
    [
      progressOf,
      rows,
      slug,
      spawned,
      litKey,
      arrivedKey,
      arrival,
      onArrivedEnd,
      liveAfter,
      handedOff,
      tabKey,
      expanded,
      failedIds,
      interruptedEnds,
      toggle,
      onRowFocus,
    ],
  );
  const liveTexts = props.liveTexts ?? NO_TEXTS;
  const pendingRows = props.pendingRows ?? NO_PENDING;
  const items =
    liveRows.length === 0 && pendingRows.length === 0
      ? rowEls
      : [
          ...rowEls,
          ...liveRows.map((row, i) => (
            <TimelineItem
              key={row.key}
              row={row}
              slug={slug}
              spawned={spawned}
              lit={false}
              arrivedKey={undefined}
              arrival={undefined}
              onArrivedEnd={onArrivedEnd}
              // Fades once, only when its first text came from a live patch, not a reset (U3 §11.4).
              live={liveTexts[i]?.fromReset === false}
              firstOfSeq={false}
              gap={rowGap(row, i === 0 ? rows.at(-1) : liveRows[i - 1])}
              tabKey={tabKey}
              expanded={expanded}
              failedIds={failedIds}
              interruptedEnds={interruptedEnds}
              toggle={toggle}
              onRowFocus={onRowFocus}
            />
          )),
          ...pendingRows.map((row, i) => (
            <TimelineItem
              key={row.key}
              row={row}
              slug={slug}
              spawned={spawned}
              lit={false}
              arrivedKey={undefined}
              arrival={undefined}
              onArrivedEnd={onArrivedEnd}
              live={false}
              firstOfSeq={false}
              gap={rowGap(row, i === 0 ? (liveRows.at(-1) ?? rows.at(-1)) : pendingRows[i - 1])}
              tabKey={tabKey}
              expanded={expanded}
              failedIds={failedIds}
              interruptedEnds={interruptedEnds}
              toggle={toggle}
              onRowFocus={onRowFocus}
            />
          )),
        ];
  const last = pendingRows.at(-1) ?? liveRows.at(-1) ?? rows.at(-1);

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} className="h-full overflow-y-auto px-4 py-4 md:px-6">
        <div
          ref={log}
          role="log"
          aria-label="Session"
          aria-live="off"
          onKeyDown={onKeyDown}
          // clip, not hidden: a leak can never scroll the conversation sideways, and the log
          // doesn't become a scroll container (the scroller around it is overflow-y-auto).
          className="max-w-[52rem] min-w-0 overflow-x-clip"
        >
          {props.hasMoreBefore && (
            <div className="mb-3 flex items-center gap-2">
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
          {/* One flat keyed array (U3 §11.4): a live block's item and the persisted row that retires it
              share a key in the same reconciliation scope, so React keeps the element. */}
          {items}
          {/* Under the rows (activity line, queue): 12px apart as before, 24px after a turn footer. */}
          <div
            className={`space-y-3 empty:hidden ${last === undefined ? "" : last.kind === "turn_footer" ? "mt-6" : "mt-3"}`}
          >
            {props.footer}
          </div>
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

type ProgressList = readonly (SubagentProgress | undefined)[];
const NO_ROW_PROGRESS = { of: (_row: Row): RowProgress => undefined, lists: new Map() };

/**
 * The live progress each row receives (U3 §11.4, §12, B1): a subagent card gets its own entry (the
 * reducer keeps an unchanged entry's identity, so a frame re-renders only the cards that changed);
 * an overflow row gets its children's entries as one array, reused while every entry is the same;
 * every other row gets `undefined`. Memoized on `live.subagents`; the arrays given out are kept after
 * commit for the next frame to compare with.
 */
function useProgressOf(subagents: readonly SubagentProgress[]): (row: Row) => RowProgress {
  const kept = useRef<ReadonlyMap<string, ProgressList>>(new Map());
  const memo = useMemo(() => {
    if (subagents.length === 0) return NO_ROW_PROGRESS;
    const byId = new Map(subagents.map((p) => [p.toolUseId, p]));
    const lists = new Map<string, ProgressList>();
    const of = (row: Row): RowProgress => {
      if (row.kind === "subagent") return byId.get(row.call.toolUseId);
      if (row.kind !== "subagent_overflow") return undefined;
      const next = row.children.map((c) => byId.get(c.call.toolUseId));
      if (next.every((p) => p === undefined)) return undefined;
      const prev = kept.current.get(row.key);
      const list =
        prev && prev.length === next.length && prev.every((p, i) => p === next[i]) ? prev : next;
      lists.set(row.key, list);
      return list;
    };
    return { of, lists };
  }, [subagents]);
  useLayoutEffect(() => {
    kept.current = memo.lists;
  }, [memo]);
  return memo.of;
}

/** A plain loop: rows are seq-ordered, but a group keeps its first child's seq, and a folded run or a
 *  merged failure its first while holding later ones (the Jump pill compares the last). */
function maxSeq(rows: Row[]): number {
  let max = 0;
  for (const r of rows) max = Math.max(max, r.seq, heldSeqs(r)?.at(-1) ?? 0);
  return max;
}

/** Only rows that are mounted: children of collapsed rows are not. A group is open through its own
 *  key or any call's (`groupOpen`). */
const hasKey = (rows: readonly Row[], key: string, expanded: ReadonlySet<string>): boolean =>
  rows.some(
    (r) =>
      r.key === key ||
      ((isFold(r) ? groupOpen(r, expanded) : expanded.has(r.key)) &&
        hasKey(childrenOf(r), key, expanded)),
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

const containsKey = (row: Row, key: string): boolean =>
  childrenOf(row).some((c) => c.key === key || containsKey(c, key));

const containsSeq = (rows: readonly Row[], seq: number): boolean =>
  rows.some(
    (r) => r.seq === seq || !!heldSeqs(r)?.includes(seq) || containsSeq(childrenOf(r), seq),
  );

/** The keys from the top-level holder down to the row a deep link lands on (U3 §7.4): a seq inside a
 *  call's children descends to its own row, so the holders can be expanded first; a merged failure is
 *  its own landing row. The top level follows `targetRowKey`. */
export function targetPath(rows: Row[], seq: number): string[] | undefined {
  const top = targetRowKey(rows, seq);
  if (top === undefined) return undefined;
  const path = [top];
  let row = rows.find((r) => r.key === top);
  // A group (or the subagent overflow) shares its first child's seq but lands on the child itself
  // (U3 §9.4, §12).
  while (row && (isFold(row) || (row.seq !== seq && !heldSeqs(row)?.includes(seq)))) {
    const kids = childrenOf(row);
    row =
      kids.find((c) => c.seq === seq) ??
      kids.find((c) => containsSeq(childrenOf(c), seq)) ??
      // A hidden event between a group's calls: the next call, as at the top level.
      (isFold(row) ? kids.find((c) => c.seq > seq) : undefined);
    if (row) path.push(row.key);
  }
  return path;
}

/** The row a deep link lands on: its own row, else the row holding it (a merged failure's repeat
 *  included), else the nearest later row
 *  (hidden events such as `usage` have none), else the last row. */
export function targetRowKey(rows: Row[], seq: number): string | undefined {
  return (
    rows.find((r) => r.seq === seq)?.key ??
    rows.find((r) => heldSeqs(r)?.includes(seq) || containsSeq(childrenOf(r), seq))?.key ??
    // A group or merged failure holding a later seq is nearer than the next row.
    rows.find((r) => r.seq > seq || (heldSeqs(r)?.at(-1) ?? 0) > seq)?.key ??
    rows.at(-1)?.key
  );
}
