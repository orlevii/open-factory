import type { Envelope } from "@open-factory/shared";
import { ArrowUpFromLine, CircleAlert, CircleCheck, ShieldAlert, Users } from "lucide-react";
import { type ReactNode, useState } from "react";
import { formatTime } from "./format";
import { AgentLink, ClampedMarkdown } from "./message-block";
import { CodePlate, QuietLine } from "./quiet-line";
import type { Row } from "./rows";

const PART_CLAMP_LINES = 8;
const WRITTEN_GAP_MS = 60_000;

/** The stored fact body holds the envelope tag's close escaped (`&lt;/factory-message>`) at most
 *  once; the escape exists only to keep quoted text from closing the envelope, so decode that one
 *  entity and nothing else. */
export const decodeFactBody = (body: string) =>
  body.replace("&lt;/factory-message>", "</factory-message>");

type Item =
  | { type: "part"; id: string; body: string; createdAt?: string }
  | { type: "fact"; id: string; fact: string; body: string };

/** A group's parts in order: a report's own text (its `parts`, or the body as one part for an
 *  update from before parts existed) and the factory's facts about it. */
function itemsOf(envelopes: Envelope[]): Item[] {
  return envelopes.flatMap((e): Item[] => {
    if (e.from === "@factory" && e.fact)
      return [{ type: "fact", id: e.id, fact: e.fact, body: decodeFactBody(e.body) }];
    const parts = e.parts?.length ? e.parts : [{ id: e.id, body: e.body, createdAt: undefined }];
    return parts.map((p) => ({ type: "part", ...p }));
  });
}

/** Consecutive updates about one report in one delivery, as one quoted-context block. Facts are
 *  keyed by their `fact` code, never by prose. */
export function UpdateGroup({
  row,
  rowProps,
}: {
  row: Extract<Row, { kind: "update_group" }>;
  rowProps: Record<string, unknown>;
}) {
  const [all, setAll] = useState(false);
  const items = itemsOf(row.envelopes);
  const parts = items.filter((i) => i.type === "part");
  const latest = parts.at(-1);
  const collapsed = !all && parts.length > 1;
  const shown = collapsed ? items.filter((i) => i.type === "fact" || i === latest) : items;
  const written = parts[0]?.createdAt;
  const late =
    written !== undefined &&
    new Date(row.at).getTime() - new Date(written).getTime() > WRITTEN_GAP_MS;
  return (
    <article
      {...rowProps}
      aria-label={`Update from @${row.about}`}
      className="border-l border-input pl-3 focus-visible:outline-2 focus-visible:outline-ring"
    >
      <div className="mb-1 flex flex-wrap items-center gap-x-2 text-[0.8125rem] leading-[1.125rem]">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <ArrowUpFromLine aria-hidden="true" className="size-3.5" />
          <span>Update from</span>
        </span>
        <span>
          <AgentLink slug={row.about} />
        </span>
        <time
          dateTime={row.at}
          title={`Received ${new Date(row.at).toLocaleTimeString()}`}
          className="text-muted-foreground"
        >
          {formatTime(row.at)}
        </time>
        {late && written && (
          <span className="text-muted-foreground">written {formatTime(written)}</span>
        )}
      </div>
      <div className="space-y-2">
        {shown.map((item, i) => (
          <div
            key={`${item.id}:${item.type}`}
            className={i > 0 && item.type === "part" ? "border-t border-border pt-2" : undefined}
          >
            {item.type === "part" ? (
              <ClampedMarkdown source={item.body} limit={PART_CLAMP_LINES} />
            ) : (
              <FactLine fact={item.fact} body={item.body} />
            )}
          </div>
        ))}
      </div>
      {collapsed && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="mt-1 text-[0.8125rem] text-muted-foreground underline-offset-4 hover:underline"
        >
          {`Show all (${parts.length} updates)`}
        </button>
      )}
    </article>
  );
}

function factIcon(fact: string): ReactNode {
  switch (fact) {
    case "turn_failed":
    case "errored":
      return <CircleAlert aria-hidden="true" className="text-destructive" />;
    case "denied":
      return <ShieldAlert aria-hidden="true" />;
    case "crashed":
    case "work_lost":
      return <CircleAlert aria-hidden="true" />;
    case "recovered":
      return <CircleCheck aria-hidden="true" />;
    default:
      return undefined;
  }
}

/** The body's first line exactly as the manager saw it; its `> ` quote goes behind a toggle. */
function FactLine({ fact, body }: { fact: string; body: string }) {
  const [open, setOpen] = useState(false);
  const [first = "", ...rest] = body.split("\n");
  const quote = rest
    .filter((l) => l.startsWith("> "))
    .map((l) => l.slice(2))
    .join("\n");
  const prominent = fact === "turn_failed" || fact === "errored";
  return (
    <div>
      <QuietLine icon={factIcon(fact)}>
        <span className={prominent ? "text-foreground" : undefined}>{first}</span>
        {quote && (
          <>
            {" "}
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              className="underline-offset-4 hover:underline"
            >
              {open ? "Hide details" : "Show details"}
            </button>
          </>
        )}
      </QuietLine>
      {open && quote && <CodePlate>{quote}</CodePlate>}
    </div>
  );
}

/** One line per peer event, built from `subject`, never from prose. */
export function PeerLine({
  envelope,
  rowProps,
}: {
  envelope: Envelope;
  rowProps: Record<string, unknown>;
}) {
  const s = envelope.subject;
  const who = s ? (
    <>
      <span className="font-mono text-foreground">@{s.slug}</span> · {s.displayName}
    </>
  ) : null;
  let what: ReactNode = "Your neighborhood changed";
  if (s) {
    if (!s.left)
      what = (
        <>
          {who} joined as your {s.relation}
        </>
      );
    else if (s.left.reason === "archived") what = <>{who} left: archived</>;
    else if (s.left.to === null) what = <>{who} left: now reports to the humans</>;
    else
      what = (
        <>
          {who} left: now reports to <span className="font-mono text-foreground">@{s.left.to}</span>
        </>
      );
  }
  return (
    <QuietLine rowProps={rowProps} icon={<Users aria-hidden="true" />}>
      {what}
    </QuietLine>
  );
}
