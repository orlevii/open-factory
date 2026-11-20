import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Clock, Factory } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Markdown } from "@/components/markdown/markdown";
import { agentsListQueryOptions, agentsQueryOptions, endedMoreQueryOptions } from "./api";
import { formatTime } from "./format";

/** The `FixLink` underline: visible and muted, turning signal on hover. */
export const LINK_CLASS =
  "underline underline-offset-4 decoration-muted-foreground hover:decoration-ring";

/** Slug -> display name for the active agents (cached list). `undefined` until it has loaded. */
const toNames = (agents: { slug: string; displayName: string }[]) =>
  new Map(agents.map((a) => [a.slug, a.displayName]));
export function useAgentNames(): Map<string, string> | undefined {
  // A module-level select: the map is rebuilt only when the list itself changes.
  return useQuery({ ...agentsQueryOptions, select: toNames }).data;
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
  const names = useAgentNames();
  const active = names?.get(slug);
  const needEnded = names !== undefined && active === undefined;
  // Many links share this lookup as a timeline fills: one fetch serves them for a while, and a
  // terminated frame invalidates it anyway (useAgentStatusFrames).
  const ended = useQuery({
    ...agentsListQueryOptions("only"),
    select: toEnded,
    enabled: needEnded,
    staleTime: ENDED_LOOKUP_STALE_MS,
    refetchOnWindowFocus: false,
  });
  const { data: more } = useQuery(endedMoreQueryOptions);
  if (!needEnded) return { link: true, display: active };
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
}) {
  const { from, system, body, urgent, at, queued, failed, badge } = props;
  return (
    <div
      data-message-block
      className={`rounded-lg border px-3 py-2 ${queued ? "border-dashed border-input" : "border-border"}`}
    >
      <div className="mb-1 flex flex-wrap items-center gap-x-2 text-[0.8125rem] leading-[1.125rem]">
        {system ? (
          <span className="flex items-center gap-1 text-foreground">
            <Factory aria-hidden="true" className="size-3.5" />
            Factory
          </span>
        ) : isAgentSender(from) ? (
          <span>
            <AgentLink slug={from} name />
          </span>
        ) : (
          <span className="font-mono text-foreground">{from}</span>
        )}
        {badge}
        {urgent && !system && (
          <span className="rounded-sm border border-border px-1.5 text-foreground">Urgent</span>
        )}
        {queued ? (
          <span className="flex items-center gap-1 text-muted-foreground">
            <Clock aria-hidden="true" className="size-3.5" />
            {queued.reason ? `Not delivered yet: ${queued.reason}` : "Not delivered yet"}
          </span>
        ) : at ? (
          <time
            dateTime={at}
            title={new Date(at).toLocaleString()}
            className="text-muted-foreground"
          >
            {formatTime(at)}
          </time>
        ) : null}
      </div>
      {failed && (
        <p className="mb-1 text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
          Not delivered
        </p>
      )}
      <ClampedMarkdown source={body} />
    </div>
  );
}

const CLAMP_LINES = 40;

/** Bodies over 40 lines clamp with "Show all" (bodies may be up to 64 KB); update parts clamp at 8. */
export function ClampedMarkdown({
  source,
  limit = CLAMP_LINES,
}: {
  source: string;
  limit?: number;
}) {
  const [all, setAll] = useState(false);
  const lines = source.split("\n");
  if (lines.length <= limit || all) return <Markdown source={source} />;
  return (
    <>
      <Markdown source={lines.slice(0, limit).join("\n")} />
      <button
        type="button"
        onClick={(e) => {
          e.currentTarget.closest<HTMLElement>("[data-row]")?.focus(); // this button unmounts
          setAll(true);
        }}
        className="mt-1 text-[0.8125rem] text-muted-foreground underline-offset-4 hover:underline"
      >
        Show all
      </button>
    </>
  );
}
