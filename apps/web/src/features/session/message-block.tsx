import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CalendarClock, Clock, Factory } from "lucide-react";
import { type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "@/components/markdown/markdown";
import { clampSource } from "@/components/markdown/split-blocks";
import { Spinner } from "@/components/ui/spinner";
import { ScheduleBadge } from "@/features/schedules/schedule-badge";
import { agentsListQueryOptions, agentsQueryOptions, endedMoreQueryOptions } from "./api";
import { formatTime } from "./format";
import { rowOf } from "./row-of";
import { SpeakerLine } from "./speaker-line";

/** The `FixLink` underline: visible and muted, turning signal on hover. */
export const LINK_CLASS =
  "underline underline-offset-4 decoration-muted-foreground hover:decoration-ring";

/** One active agent's display name (cached list): `null` when the slug isn't active, `undefined`
 *  until the list has loaded. */
export function useAgentName(slug: string): string | null | undefined {
  // A primitive select: every agent_status frame patches the list, but a link only re-renders when
  // its own name changes.
  const select = useCallback(
    (agents: { slug: string; displayName: string }[]) =>
      agents.find((a) => a.slug === slug)?.displayName ?? null,
    [slug],
  );
  return useQuery({ ...agentsQueryOptions, select }).data;
}

/** Slug -> an ended agent's display name, or null when it was archived (it stays unlinked). */
const toEnded = (agents: { slug: string; displayName: string; terminatedAt?: string }[]) =>
  new Map(agents.map((a) => [a.slug, a.terminatedAt ? a.displayName : null]));

/**
 * How to show a slug (S7 UI design §4.4): from the active list, else from the ended list (fetched
 * only when a slug isn't active). A terminated agent keeps its link and name (its read-only session
 * is worth opening); an archived or unknown one is the plain slug. A slug in neither list while
 * older ended agents exist beyond the newest 200 may be an old terminated one: it keeps the link
 * (the session route resolves any slug), without a name. `link` until the lists have loaded.
 */
const ENDED_LOOKUP_STALE_MS = 30_000;
function useAgentLinkTarget(slug: string): { link: boolean; display?: string } {
  const active = useAgentName(slug);
  const needEnded = active === null;
  // Many links share this lookup as a timeline fills: one fetch serves them for a while, and a
  // terminated frame invalidates it anyway (status-frames.ts).
  const ended = useQuery({
    ...agentsListQueryOptions("only"),
    select: toEnded,
    enabled: needEnded,
    staleTime: ENDED_LOOKUP_STALE_MS,
    refetchOnWindowFocus: false,
  });
  const { data: more } = useQuery(endedMoreQueryOptions);
  if (!needEnded) return { link: true, display: active ?? undefined };
  // A failed lookup falls back to S6's plain slug for anything not active.
  if (!ended.data) return { link: !ended.isError };
  const display = ended.data.get(slug);
  if (display) return { link: true, display };
  return { link: display === undefined && more === true };
}

/** An agent slug in mono, as a link to its session (resolved by `useAgentLinkTarget`). `name` adds
 *  " · Display name" when it is known. */
export function AgentLink({ slug, name = false }: { slug: string; name?: boolean }) {
  const { link, display } = useAgentLinkTarget(slug);
  if (!link) return <span className="font-mono text-foreground">@{slug}</span>;
  return (
    <>
      <Link
        to="/agents/$slug"
        params={{ slug }}
        aria-label={`Open @${slug}'s session`}
        className={`font-mono text-foreground ${LINK_CLASS}`}
      >
        @{slug}
      </Link>
      {name && display && <span className="text-muted-foreground"> · {display}</span>}
    </>
  );
}

/** "Mon 23 Nov 09:00 UTC+01:00": the envelope's `due` read at its own offset (the zone's name isn't on the envelope). */
export function formatDue(due: string): string {
  const m = /([+-])(\d{2}):(\d{2})$/.exec(due);
  const at = new Date(due);
  if (!m || Number.isNaN(at.getTime())) return due;
  const offMin = (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(at.getTime() + offMin * 60_000))
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  const off = offMin === 0 ? "UTC" : `UTC${m[1]}${m[2]}:${m[3]}`;
  return `${p.weekday} ${p.day} ${p.month} ${p.hour}:${p.minute} ${off}`;
}

/** Agent senders are bare slugs; humans are `@handle`, the factory `@factory`. */
export const isAgentSender = (from: string) => !from.startsWith("@");

/** Incoming input (UI design §4.1): on the ground with a 1px rule edge and 6px radius, never a bubble.
 *  The sender line is generic (`from` + badges), never the raw envelope XML. A `system` message is a
 *  notice from the factory itself (S5 UI design §3.5): sender "Factory", never Urgent, never orange. */
export function MessageBlock(props: {
  from: string;
  system?: boolean;
  body: string;
  urgent?: boolean;
  at?: string;
  queued?: { reason?: string };
  failed?: boolean;
  /** S8: the task badge of a task message, after the sender. */
  badge?: ReactNode;
  /** S9: a scheduled message: sender "Scheduler", the schedule badge, who wrote it, and the notes. */
  scheduled?: {
    key: string;
    by?: string | undefined;
    /** ISO 8601 with the schedule zone's offset (the envelope's `due`). */
    due?: string | undefined;
    late?: boolean | undefined;
    firings?: number | undefined;
  };
  /** U3 §7.6: a queued (or sending) block, its body clamped at three lines. */
  brief?: boolean;
  /** U3 §6.4: Cancel on a held message you sent, at the end of the sender line. */
  action?: ReactNode;
  /** U3 §13.2: an optimistic send, in the delivered card's shape with its body muted and named
   *  "Sending"; `label` ("Sending…") takes the time's place once the POST is slow. */
  sending?: { label?: ReactNode };
}) {
  const {
    from,
    system,
    body,
    urgent,
    at,
    queued,
    failed,
    badge,
    scheduled,
    action,
    sending,
    brief,
  } = props;
  const notes = scheduled
    ? [
        ...(scheduled.late && scheduled.due
          ? [`due ${formatDue(scheduled.due)} · delivered late`]
          : []),
        ...(scheduled.late && !scheduled.due ? ["delivered late"] : []),
        ...((scheduled.firings ?? 1) > 1 ? [`covers ${scheduled.firings} runs`] : []),
      ]
    : [];
  const status = sending ? (
    sending.label ? (
      <span className="flex items-center gap-1 text-muted-foreground">
        <Spinner size="text" />
        {sending.label}
      </span>
    ) : null
  ) : queued ? (
    <span className="flex items-center gap-1 text-muted-foreground">
      <Clock aria-hidden="true" className="size-3.5" />
      {queued.reason ? `Not delivered yet: ${queued.reason}` : "Not delivered yet"}
    </span>
  ) : null;
  // A delivered factory notice is no card: a quiet line with the factory mark and its badge, the
  // body two muted lines clamped with Show all (U3 §7.2), so an assignment's brief isn't swallowed.
  if (system && !queued && !sending)
    return (
      <div data-message-block data-notice className="text-[0.8125rem] leading-[1.125rem]">
        <div className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Factory aria-hidden="true" className="size-3.5 shrink-0" />
            Factory
          </span>
          {badge}
          {at && <Time at={at} />}
        </div>
        <div
          data-message-body
          dir="auto"
          className="mt-0.5 pl-5 text-muted-foreground [--foreground:var(--muted-foreground)]"
        >
          <NoticeBody source={body} />
        </div>
      </div>
    );
  const extras = (
    <>
      {scheduled && <ScheduleBadge scheduleKey={scheduled.key} />}
      {scheduled?.by && (
        <span className="text-muted-foreground">
          by{" "}
          {isAgentSender(scheduled.by) ? (
            <AgentLink slug={scheduled.by} />
          ) : (
            <span className="font-mono text-foreground">{scheduled.by}</span>
          )}
        </span>
      )}
      {badge}
      {urgent && !system && (
        <span className="rounded-sm border border-border px-1.5 text-foreground">Urgent</span>
      )}
    </>
  );
  return (
    <div
      data-message-block
      {...(sending ? { role: "group", "aria-label": "Sending" } : {})}
      className={`rounded-lg border bg-card px-3 py-2 ${queued ? "border-dashed border-input" : "border-border"}`}
    >
      {scheduled || system ? (
        // Scheduler and queued factory notices keep their own sender (S9, S5).
        <div className="mb-1 flex flex-wrap items-center gap-x-2 text-[0.8125rem] leading-[1.125rem]">
          <span className="flex items-center gap-1 text-foreground">
            {scheduled ? (
              <CalendarClock aria-hidden="true" className="size-3.5" />
            ) : (
              <Factory aria-hidden="true" className="size-3.5" />
            )}
            {scheduled ? "Scheduler" : "Factory"}
          </span>
          {extras}
          {status ?? (at ? <Time at={at} /> : null)}
          {action && <span className="ml-auto">{action}</span>}
        </div>
      ) : (
        <SpeakerLine from={from} at={at} status={status} action={action}>
          {extras}
        </SpeakerLine>
      )}
      {notes.length > 0 && (
        <p className="mb-1 text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
          {notes.join(" · ")}
        </p>
      )}
      {failed && (
        <p className="mb-1 text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
          Not delivered
        </p>
      )}
      {/* One wrapper either way, so a send becoming its queued item keeps the parsed body. The prose
          reads --foreground, so muting it means pointing that at the muted token. */}
      <div
        data-message-body
        dir="auto"
        className={
          [
            brief && "line-clamp-3",
            sending && "text-muted-foreground [--foreground:var(--muted-foreground)]",
          ]
            .filter(Boolean)
            .join(" ") || undefined
        }
      >
        {brief ? <Markdown source={body} variant="detail" /> : <ClampedMarkdown source={body} />}
      </div>
    </div>
  );
}

function Time({ at }: { at: string }) {
  return (
    <time
      dateTime={at}
      title={new Date(at).toLocaleString()}
      className="shrink-0 text-muted-foreground tabular-nums"
    >
      {formatTime(at)}
    </time>
  );
}

/** Past these a notice surely runs over two lines, so Show all is offered even where nothing can be
 *  measured; below them the measurement decides. */
const NOTICE_LINES = 2;
const NOTICE_CHARS = 240;

/**
 * A factory notice's body (U3 §7.2): always two muted lines (`line-clamp-2`), whatever its length,
 * with Show all when the content runs past them. Overflow is measured after layout and again when
 * the width changes; the block/character rule backs it up where layout is unknown.
 */
function NoticeBody({ source }: { source: string }) {
  const [all, setAll] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const long = useMemo(
    () => clampSource(source, NOTICE_LINES, NOTICE_CHARS) !== undefined,
    [source],
  );
  useLayoutEffect(() => {
    const el = box.current;
    if (all || !el) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [all]);
  return (
    <>
      <div ref={box} className={all ? undefined : "line-clamp-2"}>
        <Markdown source={source} variant="detail" />
      </div>
      {!all && (long || overflows) && (
        <button
          type="button"
          data-expands
          onClick={(e) => {
            rowOf(e.currentTarget)?.focus(); // this button unmounts
            setAll(true);
          }}
          className="mt-1 text-[0.8125rem] text-muted-foreground underline-offset-4 hover:underline"
        >
          Show all
        </button>
      )}
    </>
  );
}

const CLAMP_LINES = 40;

/** Message, outgoing and spawn bodies (U3 §7.6; agent text stays unclamped) clamp at 40 lines or 4,000
 *  rendered characters, whichever comes first, cut at a block boundary with "Show all" (bodies may be
 *  up to 64 KB); update parts clamp at 8 lines. "Show all" is a `data-expands` toggle: the timeline's
 *  click capture calls `expandAnchor` on its row before this expands, so nothing above moves. */
export function ClampedMarkdown({
  source,
  limit = CLAMP_LINES,
}: {
  source: string;
  limit?: number;
}) {
  const [all, setAll] = useState(false);
  const clamped = useMemo(() => clampSource(source, limit), [source, limit]);
  if (all || clamped === undefined) return <Markdown source={source} variant="detail" />;
  return (
    <>
      <Markdown source={clamped} variant="detail" />
      <button
        type="button"
        data-expands
        onClick={(e) => {
          rowOf(e.currentTarget)?.focus(); // this button unmounts
          setAll(true);
        }}
        className="mt-1 text-[0.8125rem] text-muted-foreground underline-offset-4 hover:underline"
      >
        Show all
      </button>
    </>
  );
}
