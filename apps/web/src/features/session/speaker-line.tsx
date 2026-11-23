import type { AgentSummary } from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import {
  createContext,
  memo,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { AgentChip, type ChipAgent } from "@/components/agent-chip";
import { MiddleTruncate } from "@/components/middle-truncate";
import { usersQueryOptions } from "@/features/settings/api";
import type { Session } from "@/lib/auth-client";
import { sessionQueryOptions } from "@/lib/session";
import { agentsListQueryOptions, endedMoreQueryOptions } from "./api";
import { formatTime } from "./format";
import { useLongPressRegion } from "./long-press-region";

/** How a slug shows on a speaker line: the chip's identity, and whether it links to a session. */
export type ResolvedAgent = { agent: ChipAgent; link: boolean };

/**
 * Who is speaking, for every speaker line in a session (U3 §7.2, React review m7): one value built
 * once per list change by `SpeakerProvider`, so a timeline of hundreds of messages holds no query
 * observer per row.
 */
export interface SpeakerIndex {
  /** The session's own agent: its text and its sends are never linked. */
  sessionAgent: ChipAgent | undefined;
  /** The signed-in human's handle: their own messages say "You". */
  selfHandle: string | undefined;
  /** The live agents list has loaded: before it, every slug is a stand-in. */
  ready: boolean;
  /** Live, then ended (terminated keeps its link and name, archived is the plain slug). */
  agent(slug: string): ResolvedAgent;
  /** A human's display name from the users list. */
  userName(handle: string): string | undefined;
  /** Whether `slug` is a known agent (live or ended). */
  isAgent(slug: string): boolean;
  /** A line whose agent isn't live asks once for the ended list (fetched lazily, shared). */
  requestEnded(): void;
}

type Ended = { agent: ChipAgent; terminated: boolean };

const stub = (slug: string): ChipAgent => ({ slug, displayName: `@${slug}`, stub: true });
const noop = () => {};

/** The pure part of the provider: tests build an index from plain lists. `endedMore` is true when
 *  older ended agents exist beyond the newest 200; `endedFailed` when that lookup failed. */
export function buildSpeakerIndex(o: {
  sessionAgent?: ChipAgent;
  selfHandle?: string;
  live?: readonly ChipAgent[];
  ended?: readonly (ChipAgent & { terminated: boolean })[];
  endedMore?: boolean;
  endedFailed?: boolean;
  users?: readonly (readonly [string, string])[];
  requestEnded?: () => void;
}): SpeakerIndex {
  const live = o.live ? new Map(o.live.map((a) => [a.slug, a])) : undefined;
  const ended = o.ended
    ? new Map<string, Ended>(o.ended.map((a) => [a.slug, { agent: a, terminated: a.terminated }]))
    : undefined;
  const users = new Map(o.users ?? []);
  const cache = new Map<string, ResolvedAgent>();
  const resolve = (slug: string): ResolvedAgent => {
    if (slug === o.sessionAgent?.slug) return { agent: o.sessionAgent, link: false };
    const a = live?.get(slug);
    if (a) return { agent: a, link: true };
    // Until the lists have loaded a slug keeps its link; a failed lookup is the plain slug.
    if (!live || (!ended && !o.endedFailed)) return { agent: stub(slug), link: true };
    const e = ended?.get(slug);
    if (e)
      return e.terminated ? { agent: e.agent, link: true } : { agent: stub(slug), link: false };
    // A slug in neither list may be an older terminated agent while more exist: it keeps the link.
    return { agent: stub(slug), link: !o.endedFailed && o.endedMore === true };
  };
  return {
    sessionAgent: o.sessionAgent,
    selfHandle: o.selfHandle,
    ready: live !== undefined,
    agent: (slug) => {
      let r = cache.get(slug);
      if (!r) {
        r = resolve(slug);
        cache.set(slug, r);
      }
      return r;
    },
    userName: (handle) => users.get(handle),
    isAgent: (slug) => !!live?.has(slug) || !!ended?.has(slug) || slug === o.sessionAgent?.slug,
    requestEnded: o.requestEnded ?? noop,
  };
}

const EMPTY = buildSpeakerIndex({});
export const SpeakerContext = createContext<SpeakerIndex>(EMPTY);
export const useSpeakers = () => useContext(SpeakerContext);

// Projections to what a chip shows: `select` results are structurally shared, so a status frame
// (which patches every list) leaves them, and the index built from them, identical.
const toChips = (l: AgentSummary[]): ChipAgent[] =>
  l.map((a) => ({
    slug: a.slug,
    displayName: a.displayName,
    template: a.template,
    kind: a.kind,
    avatarVersion: a.avatarVersion,
  }));
const toEnded = (l: AgentSummary[]) =>
  l.map((a) => ({
    slug: a.slug,
    displayName: a.displayName,
    template: a.template,
    kind: a.kind,
    avatarVersion: a.avatarVersion,
    terminated: !!a.terminatedAt || a.status === "terminated",
  }));
const toUsers = (l: { handle: string; name: string }[]) =>
  l.map((u) => [u.handle, u.name] as const);
const ENDED_LOOKUP_STALE_MS = 30_000;

const toHandle = (s: Session | null) => s?.user.handle;

/** One reader of the agents, ended agents and users lists for a whole session (m7), and of your
 *  handle. The session agent comes in as primitives, so a status frame on it changes nothing here;
 *  a caller that doesn't have it yet (the inbox pane) passes the slug alone and the live list's
 *  entry stands in. Mount it before the events load: the lists fetch alongside them. */
export function SpeakerProvider({
  slug,
  displayName,
  template,
  kind,
  avatarVersion,
  children,
}: {
  slug: string;
  displayName?: string;
  template?: string;
  kind?: AgentSummary["kind"];
  avatarVersion?: string | null;
  children: ReactNode;
}) {
  const selfHandle = useQuery({ ...sessionQueryOptions, select: toHandle }).data;
  const [needEnded, setNeedEnded] = useState(false);
  const requestEnded = useCallback(() => setNeedEnded(true), []);
  const live = useQuery({
    ...agentsListQueryOptions("exclude"),
    refetchOnMount: false,
    select: toChips,
  }).data;
  const ended = useQuery({
    ...agentsListQueryOptions("only"),
    select: toEnded,
    enabled: needEnded,
    staleTime: ENDED_LOOKUP_STALE_MS,
    refetchOnWindowFocus: false,
  });
  const { data: more } = useQuery(endedMoreQueryOptions);
  const users = useQuery({ ...usersQueryOptions, select: toUsers, staleTime: 60_000 }).data;
  const value = useMemo(
    () =>
      buildSpeakerIndex({
        sessionAgent:
          displayName !== undefined
            ? { slug, displayName, template, kind, avatarVersion }
            : (live?.find((a) => a.slug === slug) ?? stub(slug)),
        selfHandle,
        live,
        ended: ended.data,
        endedMore: more,
        endedFailed: ended.isError,
        users,
        requestEnded,
      }),
    [
      slug,
      displayName,
      template,
      kind,
      avatarVersion,
      selfHandle,
      live,
      ended.data,
      ended.isError,
      more,
      users,
      requestEnded,
    ],
  );
  return <SpeakerContext value={value}>{children}</SpeakerContext>;
}

/** Below a 20rem container the handle hides (the name's tooltip keeps it). */
const SLUG_CLASS = "@max-[20rem]:hidden";
const NAME_CLASS = "font-medium text-foreground";

/** Who a handle belongs to: the server says (envelope, queue item, send result), never guessed from a
 *  sigil. Only a call's own arguments carry no kind: those recipients are looked up (a handle is unique
 *  across kinds). */
export type PartyKind = "agent" | "human";
/** A sender can also be the factory itself. */
export type SenderKind = PartyKind | "factory";
export type Party = { handle: string; kind?: PartyKind | undefined };

const bareHandle = (h: string) => (h.startsWith("@") ? h.slice(1) : h);

/** One side of a speaker line: an agent chip, a human's name and handle, or "You". */
function Speaker({ id, kind, self }: { id: string; kind?: SenderKind | undefined; self: boolean }) {
  const s = useSpeakers();
  const handle = bareHandle(id);
  const known = kind ?? (s.isAgent(handle) ? "agent" : "human");
  const human = known === "human";
  const resolved = known === "agent" ? s.agent(handle) : undefined;
  // Only once the live list is in: before it, every slug is a stand-in.
  const needEnded = s.ready && !human && resolved?.agent.stub === true && !self;
  const { requestEnded } = s;
  useEffect(() => {
    if (needEnded) requestEnded();
  }, [needEnded, requestEnded]);
  if (known === "factory")
    return (
      <span dir="auto" className="min-w-0 truncate font-mono text-foreground">
        @{handle}
      </span>
    );
  if (resolved)
    return (
      <AgentChip
        agent={resolved.agent}
        size={20}
        showSlug
        link={resolved.link && !self}
        inline
        className={NAME_CLASS}
        slugClassName={`font-normal ${SLUG_CLASS}`}
      />
    );
  if (s.selfHandle !== undefined && handle === s.selfHandle)
    return (
      <span dir="auto" className={NAME_CLASS}>
        You
      </span>
    );
  const name = s.userName(handle);
  if (!name)
    return (
      <span dir="auto" className="min-w-0 truncate font-mono text-foreground">
        @{handle}
      </span>
    );
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span dir="auto" title={`${name} @${handle}`} className={`min-w-0 truncate ${NAME_CLASS}`}>
        {name}
      </span>
      <span
        title={`@${handle}`}
        className={`min-w-0 font-mono text-muted-foreground ${SLUG_CLASS}`}
      >
        <MiddleTruncate text={`@${handle}`} />
      </span>
    </span>
  );
}

/** Recipients shown on a line before "+N". */
const SHOWN_RECIPIENTS = 2;
const COUNT = new Intl.NumberFormat("en");

/** "@a, @b +8": the first two handles, then how many more. The full list is the line's accessible
 *  name and the row menu's Recipients item. */
export function recipientSummary(handles: readonly string[]): string {
  const shown = handles.slice(0, SHOWN_RECIPIENTS).join(", ");
  const more = handles.length - SHOWN_RECIPIENTS;
  return more > 0 ? `${shown} +${COUNT.format(more)}` : shown;
}

/**
 * `[avatar 20] Name  @handle  14:02` (U3 §7.2): agents as a chip linking to their session (never
 * the session's own agent: `self`), humans by name or handle, your own messages "You". With `to`,
 * an outgoing card's "Name → Recipient", or "Name → @a, @b +8" for several (I1 §4.7). `children` (badges)
 * follow the names; `status` takes the time's place (queued, sending); `action` sits at the end.
 */
export const SpeakerLine = memo(function SpeakerLine({
  from,
  fromKind,
  to,
  at,
  self = false,
  status,
  action,
  children,
}: {
  /** A handle, with or without its `@`. */
  from: string;
  /** What `from` is; the server carries it on every sender, so it is never looked up or guessed. */
  fromKind: SenderKind;
  /** An outgoing card's recipients, in send order. Keep the array identity stable across renders. */
  to?: readonly Party[];
  at?: string;
  /** `from` is the session's own agent: no link. */
  self?: boolean;
  status?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  // On a timeline row, a long-press here opens the row's menu (U4 §11.2).
  const region = useLongPressRegion();
  const several = to !== undefined && to.length > 1;
  return (
    <div
      data-speaker-line
      {...region}
      {...(several
        ? {
            role: "group",
            "aria-label": `To ${to.map((r) => `@${bareHandle(r.handle)}`).join(", ")}`,
          }
        : {})}
      className="@container mb-1 flex min-w-0 flex-wrap items-center gap-x-2 text-[0.8125rem] leading-[1.125rem]"
    >
      {/* The names and the time never wrap apart: alone on its line the group shrinks, and the names
          truncate before the time (which never does). Badges, a status or an action may wrap below,
          so a long badge never squeezes the names away. */}
      <span className="flex min-w-0 flex-nowrap items-center gap-x-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <Speaker id={from} kind={fromKind} self={self} />
          {to?.[0] && (
            <>
              <ArrowRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
              {several ? (
                <span dir="auto" className="min-w-0 truncate font-mono text-foreground">
                  {recipientSummary(to.map((r) => `@${bareHandle(r.handle)}`))}
                </span>
              ) : (
                <Speaker id={to[0].handle} kind={to[0].kind} self={false} />
              )}
            </>
          )}
        </span>
        {status == null && at ? (
          <time
            dateTime={at}
            title={new Date(at).toLocaleString()}
            className="shrink-0 text-muted-foreground tabular-nums"
          >
            {formatTime(at)}
          </time>
        ) : null}
      </span>
      {children}
      {status}
      {action && <span className="ml-auto">{action}</span>}
    </div>
  );
});
