import type { MessageAttachment } from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CalendarClock, Clock, Factory, FileText, Image as ImageIcon } from "lucide-react";
import { type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { displayName } from "@/components/composer/attachments";
import { Markdown } from "@/components/markdown/markdown";
import { clampSource, longestFence } from "@/components/markdown/split-blocks";
import { MiddleTruncate } from "@/components/middle-truncate";
import { Spinner } from "@/components/ui/spinner";
import { ScheduleBadge } from "@/features/schedules/schedule-badge";
import { agentsListQueryOptions, agentsQueryOptions, endedMoreQueryOptions } from "./api";
import { formatTime } from "./format";
import { useLongPressRegion } from "./long-press-region";
import { rowOf } from "./row-of";
import { SpeakerLine } from "./speaker-line";
import { stripAttachedLines } from "./uploads";

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
  /** U3 §13.5: the message's confirmed uploads (the envelope's list), shown as chips; their
   *  `[attached: …]` lines are hidden. Needs `slug` for the previews. */
  attachments?: readonly MessageAttachment[] | undefined;
  slug?: string;
}) {
  const region = useLongPressRegion();
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
    attachments,
    slug,
  } = props;
  // Only the lines of this message's own uploads go; a typed `[attached: …]` stays text.
  // The chips render only with a slug: without them the lines stay, so no file ever disappears.
  const chips = attachments?.length && slug ? attachments : undefined;
  const shown = useMemo(() => stripAttachedLines(body, chips), [body, chips]);
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
          {/* A notice's single newlines are its line breaks ("assigned you T-1" / "The task, …"). */}
          <LinesBody source={body} lines={2} className="[&_p]:whitespace-pre-line" />
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
      // pr-9: the row menu's ⋯ sits inside the card (U3 §7.5); queued and Sending cards keep the same
      // padding, so a body wraps the same before and after the handoff.
      className={`rounded-lg border bg-card py-2 pr-9 pl-3 ${queued ? "border-dashed border-input" : "border-border"}`}
    >
      {scheduled || system ? (
        // Scheduler and queued factory notices keep their own sender (S9, S5); a long-press region, as a
        // speaker line is (U4 §11.2).
        <div
          {...region}
          className="mb-1 flex flex-wrap items-center gap-x-2 text-[0.8125rem] leading-[1.125rem]"
        >
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
          sending ? "text-muted-foreground [--foreground:var(--muted-foreground)]" : undefined
        }
      >
        {brief ? <LinesBody source={shown} lines={3} /> : <ClampedMarkdown source={shown} />}
      </div>
      {chips && slug ? <AttachmentList slug={slug} attachments={chips} /> : null}
    </div>
  );
}

/** The upload's same-origin, authenticated URL (the session cookie; never an external host). */
export const uploadUrl = (slug: string, uploadId: string) =>
  `/api/agents/${encodeURIComponent(slug)}/uploads/${encodeURIComponent(uploadId)}`;

/** Images up to this size preview automatically; a larger one (or one whose size the envelope doesn't carry)
 *  waits for "Show preview", so a timeline never downloads and decodes a 20 MB image to show 28px. */
export const AUTO_PREVIEW_BYTES = 1024 * 1024;

/** A message's files (U3 §13.5): each a chip opening the file; an image previews through the
 *  authenticated same-origin GET. The name is a text node, never HTML. */
function AttachmentList({
  slug,
  attachments,
}: {
  slug: string;
  attachments: readonly MessageAttachment[];
}) {
  return (
    <ul aria-label="Attached files" className="mt-2 flex flex-wrap gap-1.5">
      {attachments.map((a) => (
        <AttachmentChip key={a.uploadId} slug={slug} attachment={a} />
      ))}
    </ul>
  );
}

function AttachmentChip({ slug, attachment: a }: { slug: string; attachment: MessageAttachment }) {
  const url = uploadUrl(slug, a.uploadId);
  const name = displayName(a.name);
  const small = a.bytes !== undefined && a.bytes <= AUTO_PREVIEW_BYTES;
  const [asked, setAsked] = useState(false);
  const preview = a.kind === "image" && (small || asked);
  return (
    <li className="flex min-w-0 items-center gap-1">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        data-attachment
        className="flex h-9 max-w-[12rem] min-w-0 items-center gap-1.5 rounded-sm border border-border bg-background pr-2 pl-1 text-[0.8125rem] leading-4 text-foreground hover:border-ring"
      >
        {preview ? (
          <img
            src={url}
            alt=""
            loading="lazy"
            decoding="async"
            width={28}
            height={28}
            className="size-7 shrink-0 rounded-[3px] object-cover"
          />
        ) : a.kind === "image" ? (
          <ImageIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span dir="auto" className="min-w-0">
          <MiddleTruncate text={name} keepEnd headMin />
        </span>
      </a>
      {a.kind === "image" && !preview ? (
        <button
          type="button"
          onClick={() => setAsked(true)}
          aria-label={`Show preview of ${name}`}
          className="text-[0.8125rem] text-muted-foreground underline-offset-4 hover:underline"
        >
          Show preview
        </button>
      ) : null}
    </li>
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

/** What a clamped body renders while clamped (`clampSource`), well past its visible lines: a 64 KB
 *  body never lays out in full, and a code block, which `line-clamp` doesn't stop, stays short. */
const CUT_LINES = 12;
const CUT_CHARS = 1200;
/** Past this many rendered characters per line a body surely runs over its lines, so Show all is
 *  offered where nothing can be measured; once layout has measured the box, the measurement decides. */
const CHARS_PER_LINE = 120;
/** Literal classes per line count (Tailwind reads the source): the clamp, and a code plate capped at
 *  the box's height. A `pre` is its own formatting context, so `line-clamp` skips its lines and its
 *  clipped lines never reach the box's `scrollHeight`; inside its 24px of padding the cap shows about
 *  `lines - 1` code lines (13/1.55, about 20px each). Show all is offered for any fence longer. */
const CLAMP_CLASS = {
  2: "line-clamp-2 [&_pre]:max-h-12 [&_pre]:overflow-hidden",
  3: "line-clamp-3 [&_pre]:max-h-[4.5rem] [&_pre]:overflow-hidden",
} as const;

/**
 * A body shown as a few lines with Show all (U3 §7.2, §7.6): a factory notice's two muted lines, a
 * queued or sending message's three. The source is cut before rendering, and the box clamped; overflow
 * is measured after layout and again when the width changes. `className` (a notice's soft line
 * breaks) applies to the clamped box.
 */
function LinesBody({
  source,
  lines,
  className,
}: {
  source: string;
  lines: 2 | 3;
  className?: string;
}) {
  const [all, setAll] = useState(false);
  /** undefined until layout has measured the box (or where it can't: no layout). */
  const [overflows, setOverflows] = useState<boolean | undefined>(undefined);
  const box = useRef<HTMLDivElement>(null);
  const cut = useMemo(() => clampSource(source, CUT_LINES, CUT_CHARS), [source]);
  const long = useMemo(
    () => cut !== undefined || clampSource(source, lines, lines * CHARS_PER_LINE) !== undefined,
    [source, cut, lines],
  );
  // A fence the capped plate can't show whole: offered however the box measures.
  const longCode = useMemo(() => longestFence(source) >= lines, [source, lines]);
  useLayoutEffect(() => {
    const el = box.current;
    if (all || !el) return;
    // The box, and each capped plate on its own: a plate's hidden lines never reach the box.
    const over = (n: HTMLElement) => n.scrollHeight > n.clientHeight + 1;
    const measure = () =>
      setOverflows(
        el.clientHeight > 0
          ? over(el) || [...el.querySelectorAll<HTMLElement>("pre")].some(over)
          : undefined,
      );
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [all]);
  const more = !all && (cut !== undefined || longCode || (overflows ?? long));
  return (
    <>
      <div
        ref={box}
        className={[all ? undefined : CLAMP_CLASS[lines], className].filter(Boolean).join(" ")}
      >
        <Markdown source={all ? source : (cut ?? source)} variant="detail" />
      </div>
      {more && <ShowAll onShow={() => setAll(true)} />}
    </>
  );
}

/** "Show all", a `data-expands` toggle: the timeline's click capture anchors its row before the body
 *  expands. The button unmounts, so focus moves to the row first, without scrolling it into view:
 *  nothing above moves. */
export function ShowAll({ onShow }: { onShow(): void }) {
  return (
    <button
      type="button"
      data-expands
      onClick={(e) => {
        // `rowOf`: a body control (a tool body's) belongs to the row above it, not an ancestor.
        rowOf(e.currentTarget)?.focus({ preventScroll: true });
        onShow();
      }}
      className="mt-1 text-[0.8125rem] text-muted-foreground underline-offset-4 hover:underline"
    >
      Show all
    </button>
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
      <ShowAll onShow={() => setAll(true)} />
    </>
  );
}
