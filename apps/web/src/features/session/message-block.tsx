import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Clock, Factory } from "lucide-react";
import { useState } from "react";
import { Markdown } from "@/components/markdown/markdown";
import { agentsQueryOptions } from "./api";
import { formatTime } from "./format";

/** The `FixLink` underline: visible and muted, turning signal on hover. */
export const LINK_CLASS =
  "underline underline-offset-4 decoration-muted-foreground hover:decoration-ring";

/** Slug -> display name for the active agents (cached list). `undefined` until it has loaded. */
export function useAgentNames(): Map<string, string> | undefined {
  const { data } = useQuery(agentsQueryOptions);
  return data && new Map(data.map((a) => [a.slug, a.displayName]));
}

/** An agent slug in mono, as a link to its session. An archived or unknown agent (once the list has
 *  loaded) is the plain slug, with no link and no display name. `name` adds " · Display name". */
export function AgentLink({ slug, name = false }: { slug: string; name?: boolean }) {
  const names = useAgentNames();
  const display = names?.get(slug);
  if (names && display === undefined)
    return <span className="font-mono text-foreground">@{slug}</span>;
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
}) {
  const { from, system, body, urgent, at, queued, failed } = props;
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
        onClick={() => setAll(true)}
        className="mt-1 text-[0.8125rem] text-muted-foreground underline-offset-4 hover:underline"
      >
        Show all
      </button>
    </>
  );
}
