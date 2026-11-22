import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { z } from "zod";
import { formatTime } from "./format";
import { ClampedMarkdown } from "./message-block";
import type { Row } from "./rows";
import { SpeakerLine, useSpeakers } from "./speaker-line";
import { denialText, ToolCallRow } from "./tool-call-row";

type OutgoingRow = Extract<Row, { kind: "outgoing" }>;

const sendResultSchema = z.object({
  id: z.string(),
  to: z.string(),
  status: z.string(),
  note: z.string().optional(),
});

type SendResult = z.infer<typeof sendResultSchema>;

/** Parsed results by event: a result event keeps its identity in the session's events map, so each
 *  is parsed once rather than on every frame. */
const parsedResults = new WeakMap<NonNullable<OutgoingRow["result"]>, SendResult | undefined>();

/** The tool's success result (`{ id, to, status, note? }`), or undefined for an error or odd text. */
export function parseSendResult(result: OutgoingRow["result"]): SendResult | undefined {
  if (!result || result.isError) return undefined;
  if (parsedResults.has(result)) return parsedResults.get(result);
  let sent: SendResult | undefined;
  try {
    const r = sendResultSchema.safeParse(JSON.parse(result.content));
    sent = r.success ? r.data : undefined;
  } catch {
    sent = undefined;
  }
  parsedResults.set(result, sent);
  return sent;
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
  const input = row.call.input as { to: string; body: string; urgent?: unknown };
  const sent = parseSendResult(row.result);
  const target = sent?.to ?? input.to;
  const bare = target.replace(/^@/, "");
  const speakers = useSpeakers();
  // A result names agents bare and humans `@handle`; an unanswered call is only the argument.
  const toAgent = sent
    ? !sent.to.startsWith("@")
    : !target.startsWith("@") || (bare !== "humans" && speakers.isAgent(bare));
  const recipient = `@${bare}`;
  const failed = row.result?.isError === true;
  return (
    <CallBlock
      row={row}
      label={`Message from @${slug} to ${recipient}`}
      showCall={showCall}
      onToggleCall={onToggleCall}
      rowProps={rowProps}
      header={
        // "Name → Recipient" (U3 §7.2): "You" for you, "All humans" for @humans.
        <SpeakerLine from={slug} self to={toAgent ? bare : recipient} at={row.at}>
          {input.urgent === true && (
            <span className="rounded-sm border border-border px-1.5 text-foreground">Urgent</span>
          )}
        </SpeakerLine>
      }
      footer={failed || row.denial ? <FailedNote row={row} /> : sendNote(row, sent, toAgent, bare)}
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
      className="rounded-lg border border-border bg-card px-3 py-2"
    >
      {header ?? (
        <div className="mb-1 flex flex-wrap items-center gap-x-2 text-[0.8125rem] leading-[1.125rem]">
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

/** The status line's content, or null when a plain delivery leaves nothing to say. */
function sendNote(
  row: OutgoingRow,
  sent: ReturnType<typeof parseSendResult>,
  toAgent: boolean,
  bare: string,
): ReactNode {
  if (!row.result) return <span>{row.turnOpen ? "Sending…" : "Not sent"}</span>;
  // Delivered plainly: the card says nothing more (U3 §7.5); a state or a note still shows.
  const state = sent && toAgent ? STATUS_TEXT[sent.status] : undefined;
  if (!state && !sent?.note) return null;
  return (
    <>
      {state && (
        <span>
          Sent · <span className="font-mono">@{bare}</span> was {state}
        </span>
      )}
      {sent?.note && <span>{sent.note}</span>}
    </>
  );
}
