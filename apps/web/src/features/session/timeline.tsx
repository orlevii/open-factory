import { ArrowDown, Check, Ellipsis, Link2 } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Row } from "./rows";
import { TimelineRow } from "./timeline-row";

const NEAR_BOTTOM = 64;

/** The only scrolling region: stick-to-bottom, "N new events", Load earlier with a scroll anchor,
 *  deep-link centring and tint, and one tab stop with roving focus (UI design §4.3, §7). */
export function Timeline(props: {
  slug: string;
  rows: Row[];
  failedIds: Set<string>;
  interruptedEnds: Set<number>;
  highlightSeq?: number;
  hasMoreBefore: boolean;
  onLoadEarlier(): Promise<void>;
  footer: ReactNode;
}) {
  const { rows } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prevLastKey = useRef<string | undefined>(undefined);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const centred = useRef(false);
  const [unseen, setUnseen] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [activeKey, setActiveKey] = useState<string | undefined>();
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [highlight, setHighlight] = useState(props.highlightSeq);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const lastKey = rows.at(-1)?.key;
    const prevIndex = rows.findIndex((r) => r.key === prevLastKey.current);
    const appended = prevIndex < 0 ? 0 : rows.length - 1 - prevIndex;
    prevLastKey.current = lastKey;
    if (anchor.current) {
      // Load earlier: keep the first visible row where it was.
      el.scrollTop = anchor.current.top + (el.scrollHeight - anchor.current.height);
      anchor.current = null;
      return;
    }
    if (highlight !== undefined && !centred.current) {
      const target = document.getElementById(`event-${highlight}`);
      if (target) {
        centred.current = true;
        atBottom.current = false;
        target.scrollIntoView?.({ block: "center" });
        return;
      }
    }
    if (atBottom.current)
      el.scrollTop = el.scrollHeight; // instant: events arrive tens of times a minute
    else if (appended > 0) setUnseen((n) => n + appended);
  }, [rows, highlight]);

  // The tint stays until the user clicks somewhere other than the highlighted row.
  useEffect(() => {
    if (highlight === undefined) return;
    const onPointerDown = (e: PointerEvent) => {
      const row = document.getElementById(`event-${highlight}`);
      if (!row?.contains(e.target as Node)) setHighlight(undefined);
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
    if (el) anchor.current = { height: el.scrollHeight, top: el.scrollTop };
    setLoadingEarlier(true);
    try {
      await props.onLoadEarlier();
    } finally {
      setLoadingEarlier(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const list = [...(scroller.current?.querySelectorAll<HTMLElement>("[data-row]") ?? [])];
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
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
  const tabKey = activeKey !== undefined && hasKey(rows, activeKey) ? activeKey : rows[0]?.key;
  const rowProps = (row: Row) => ({
    "data-row": row.key,
    tabIndex: row.key === tabKey ? 0 : -1,
    onFocus: () => setActiveKey(row.key),
  });
  const toggle = (k: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto px-4 py-4 md:px-6">
        <div
          role="log"
          aria-label="Session"
          aria-live="off"
          onKeyDown={onKeyDown}
          className="max-w-[52rem] space-y-3"
        >
          {props.hasMoreBefore && (
            <Button variant="ghost" size="sm" onClick={loadEarlier} disabled={loadingEarlier}>
              {loadingEarlier ? "Loading…" : "Load earlier"}
            </Button>
          )}
          {rows.map((row) => {
            const lit = row.seq === highlight;
            return (
              <div
                key={row.key}
                // one id per seq (a message_in with several envelopes renders several rows)
                {...(row.kind !== "message" || row.key.endsWith(":0")
                  ? { id: `event-${row.seq}` }
                  : {})}
                {...(lit ? { "data-highlighted": "true" } : {})}
                className={`group relative rounded-md pr-8 ${row.kind === "message" ? "pt-3" : ""} ${lit ? "bg-[color-mix(in_oklab,var(--signal)_26%,transparent)]" : ""}`}
              >
                <TimelineRow
                  row={row}
                  expanded={expanded}
                  toggle={toggle}
                  rowProps={rowProps}
                  failedIds={props.failedIds}
                  interruptedEnds={props.interruptedEnds}
                />
                <CopyLink slug={props.slug} seq={row.seq} focusable={row.key === tabKey} />
              </div>
            );
          })}
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
          <ArrowDown aria-hidden="true" /> {unseen} new events
        </Button>
      )}
    </div>
  );
}

const hasKey = (rows: Row[], key: string): boolean =>
  rows.some((r) => r.key === key || (r.kind === "tool" && hasKey(r.children, key)));

/** Hover / focus-within icon on fine pointers; an always-visible ⋯ menu on touch (UI design §4.3). */
function CopyLink({ slug, seq, focusable }: { slug: string; seq: number; focusable: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = () => {
    void navigator.clipboard
      ?.writeText(`${location.origin}/agents/${encodeURIComponent(slug)}?event=${seq}`)
      .then(() => setCopied(true));
  };
  return (
    <>
      <button
        type="button"
        tabIndex={focusable ? 0 : -1}
        aria-label={copied ? "Copied" : "Copy link"}
        onClick={copy}
        className="absolute top-1 right-0 hidden rounded-md p-1 text-muted-foreground group-focus-within:block group-hover:block hover:bg-accent hover:text-foreground pointer-coarse:hidden!"
      >
        {copied ? (
          <Check aria-hidden="true" className="size-3.5" />
        ) : (
          <Link2 aria-hidden="true" className="size-3.5" />
        )}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Row actions"
          tabIndex={-1}
          className="absolute top-1 right-0 hidden rounded-md p-1 text-muted-foreground pointer-coarse:block"
        >
          <Ellipsis aria-hidden="true" className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={copy}>Copy link</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
