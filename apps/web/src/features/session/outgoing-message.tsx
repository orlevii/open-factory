import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { z } from "zod";
import { formatTime } from "./format";
import { useLongPressRegion } from "./long-press-region";
import { ClampedMarkdown } from "./message-block";
import type { Row } from "./rows";
import { type Party, type PartyKind, SpeakerLine } from "./speaker-line";
import { denialText, ToolCallRow } from "./tool-call-row";
import { parseWho, whoName } from "./who";

type OutgoingRow = Extract<Row, { kind: "outgoing" }>;

const refusedSchema = z.object({
  to: z.string(),
  status: z.literal("refused"),
  reason: z.string(),
});
const reachedSchema = z.object({
  to: z.string(),
  kind: z.enum(["human", "agent"]),
  status: z.string(),
  id: z.string(),
  recipient_status: z.string().optional(),
  note: z.string().optional(),
});
const recipientResultSchema = z.union([refusedSchema, reachedSchema]);
export type RecipientResult = z.infer<typeof recipientResultSchema>;
type SendResults = { results: RecipientResult[] };
// Elements parse one by one: an entry the schema doesn't know is dropped, never the whole list.
const sendResultsSchema = z.object({ results: z.array(z.unknown()) });

/** Parsed results by event: a result event keeps its identity in the session's events map, so each
 *  is parsed once rather than on every frame. */
const parsedResults = new WeakMap<NonNullable<OutgoingRow["result"]>, SendResults | undefined>();

/** The tool's success result (`{ results: [one per recipient] }`), or undefined for an error or odd text. */
export function parseSendResults(result: OutgoingRow["result"]): SendResults | undefined {
  if (!result || result.isError) return undefined;
  if (parsedResults.has(result)) return parsedResults.get(result);
  let sent: SendResults | undefined;
  try {
    const r = sendResultsSchema.safeParse(JSON.parse(result.content));
    sent = r.success
      ? {
          results: r.data.results.flatMap((x) => {
            const one = recipientResultSchema.safeParse(x);
            return one.success ? [one.data] : [];
          }),
        }
      : undefined;
  } catch {
    sent = undefined;
  }
  parsedResults.set(result, sent);
  return sent;
}

const recipientsOf = new WeakMap<object, readonly Party[]>();
/** The recipients the call addressed, in order, each with its kind once a result names it. Cached by
 *  the result (or, before one arrives, the call), so the speaker line's props stay identical. */
function partiesOf(row: OutgoingRow, to: readonly string[]): readonly Party[] {
  const key = row.result ?? row.call;
  let parties = recipientsOf.get(key);
  if (!parties) {
    // A result names its recipient as a tag; the call may have written a tag, a ref or a plain handle.
    const byRef = new Map<string, { name: string; kind: PartyKind }>();
    const byName = new Map<string, { name: string; kind: PartyKind }>();
    for (const r of parseSendResults(row.result)?.results ?? [])
      if ("kind" in r) {
        const entry = { name: whoName(r.to), kind: r.kind };
        const ref = parseWho(r.to)?.ref;
        if (ref) byRef.set(ref, entry);
        byName.set(entry.name.toLowerCase(), entry);
      }
    parties = to.map((t) => {
      const ref = parseWho(t)?.ref;
      const found = (ref && byRef.get(ref)) || byName.get(whoName(t).toLowerCase());
      return { handle: found?.name ?? whoName(t), kind: found?.kind };
    });
    recipientsOf.set(key, parties);
  }
  return parties;
}

const STATUS_TEXT: Record<string, string> = {
  hibernated: "hibernated",
  queued: "queued",
  rate_limited: "rate-limited",
  errored: "errored",
};

/** The agent's own `send_message` call as a message block (UI design §2.5): direction in the sender
 *  line, the body as written, and a status line only when there is something to say. The call, the
 *  inbox and the links live in the row menu (U3 §7.5). */
export function OutgoingMessage({
  slug,
  row,
  showCall,
  onToggleCall,
  rowProps,
}: {
  slug: string;
  row: OutgoingRow;
  showCall: boolean;
  onToggleCall(): void;
  rowProps: Record<string, unknown>;
}) {
  const input = row.call.input as { to: string[]; body: string; urgent?: unknown };
  const sent = parseSendResults(row.result);
  const parties = partiesOf(row, input.to);
  const failed = row.result?.isError === true;
  return (
    <CallBlock
      row={row}
      label={`Message from @${slug} to ${parties.map((p) => p.handle).join(", ")}`}
      showCall={showCall}
      onToggleCall={onToggleCall}
      rowProps={rowProps}
      header={
        // "Name → Recipient" (U3 §7.2): "You" for you; several: "Name → @a, @b +8" (I1 §4.7).
        <SpeakerLine from={slug} fromKind="agent" self to={parties} at={row.at}>
          {input.urgent === true && (
            <span className="rounded-sm border border-border px-1.5 text-foreground">Urgent</span>
          )}
        </SpeakerLine>
      }
      footer={failed || row.denial ? <FailedNote row={row} /> : sendNote(row, sent)}
    >
      <div dir="auto">
        <ClampedMarkdown source={input.body} />
      </div>
    </CallBlock>
  );
}

type BlockRow = Extract<Row, { kind: "outgoing" | "spawn" }>;

/** The failed-tool treatment (S3): a small crimson icon and the tool's sentence (or the denial's) in
 *  muted text. */
export function FailedNote({ row }: { row: BlockRow }) {
  return (
    <span className="flex items-center gap-1.5">
      <CircleAlert aria-hidden="true" className="size-3.5 shrink-0 text-destructive" />
      <span className="min-w-0 [overflow-wrap:anywhere]">
        {row.denial ? denialText(row.denial.reason) : row.result?.content}
      </span>
    </span>
  );
}

/** The outgoing-block shell shared by a send and a spawn (S6 UI design §2.5, S7 §4.1): a 1px rule
 *  edge and 6px radius, the sender line and its time, the body, a muted status line when there is
 *  one, and the raw call as S3's tool row while the row menu's "View tool call" shows it. */
export function CallBlock({
  row,
  label,
  sender,
  header,
  footer,
  children,
  showCall,
  onToggleCall,
  rowProps,
}: {
  row: BlockRow;
  label: string;
  sender?: ReactNode;
  /** A whole sender line (a speaker line) in place of `sender` and the time. */
  header?: ReactNode;
  /** Null when there is nothing to say. */
  footer: ReactNode;
  children: ReactNode;
  showCall: boolean;
  onToggleCall(): void;
  rowProps: Record<string, unknown>;
}) {
  const region = useLongPressRegion();
  const failed = row.result?.isError === true;
  const toolRow: Extract<Row, { kind: "tool" }> = {
    kind: "tool",
    seq: row.seq,
    at: row.at,
    call: row.call,
    ...(row.result ? { result: row.result } : {}),
    ...(row.denial ? { denial: row.denial } : {}),
    state: row.result ? (failed ? "failed" : "done") : row.turnOpen ? "running" : "no_result",
    children: [],
    key: row.key,
  };
  return (
    <article
      {...rowProps}
      aria-label={label}
      // pr-9: the row menu's ⋯ sits inside the card (U3 §7.5).
      className="rounded-lg border border-border bg-card py-2 pr-9 pl-3"
    >
      {header ?? (
        // The sender line: a long-press region, as a speaker line is (U4 §11.2).
        <div
          {...region}
          className="mb-1 flex flex-wrap items-center gap-x-2 text-[0.8125rem] leading-[1.125rem]"
        >
          {sender}
          <time
            dateTime={row.at}
            title={new Date(row.at).toLocaleString()}
            className="shrink-0 text-muted-foreground"
          >
            {formatTime(row.at)}
          </time>
        </div>
      )}
      {children}
      {footer != null && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
          {footer}
        </div>
      )}
      {showCall && (
        <div className="mt-2">
          <ToolCallRow row={toolRow} expanded onToggle={onToggleCall} rowProps={{}} />
        </div>
      )}
    </article>
  );
}

/** The status lines' content: one muted line per recipient that wasn't plainly delivered, or null
 *  when a plain delivery leaves nothing to say. */
function sendNote(row: OutgoingRow, sent: SendResults | undefined): ReactNode {
  if (!row.result) return <span>{row.turnOpen ? "Sending…" : "Not sent"}</span>;
  const lines = (sent?.results ?? []).flatMap((r): ReactNode[] => {
    const who = whoName(r.to);
    if ("reason" in r)
      return [
        <span key={who}>
          Not sent to {who}: {r.reason}
        </span>,
      ];
    // Held by the loop guard: the status line wins over the note, which is written for the agent.
    if (r.status === "held")
      return [
        <span key={who}>
          Held by the loop guard: <span className="font-mono">{who}</span>
        </span>,
      ];
    // The server's note replaces the status text for that recipient (it already says what the status means).
    if (r.note) return [<span key={who}>{r.note}</span>];
    if (r.status === "pending")
      return [
        <span key={who}>
          Not delivered yet to <span className="font-mono">{who}</span>
        </span>,
      ];
    const state = r.kind === "agent" ? STATUS_TEXT[r.recipient_status ?? ""] : undefined;
    return state
      ? [
          <span key={who}>
            Sent · <span className="font-mono">{who}</span> was {state}
          </span>,
        ]
      : [];
  });
  return lines.length ? <div className="flex basis-full flex-col gap-0.5">{lines}</div> : null;
}
