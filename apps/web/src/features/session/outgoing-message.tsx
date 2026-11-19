import { Link } from "@tanstack/react-router";
import { ArrowRight, CircleAlert } from "lucide-react";
import { z } from "zod";
import { formatTime } from "./format";
import { AgentLink, ClampedMarkdown, LINK_CLASS, useAgentNames } from "./message-block";
import type { Row } from "./rows";
import { denialText, ToolCallRow } from "./tool-call-row";

type OutgoingRow = Extract<Row, { kind: "outgoing" }>;

const sendResultSchema = z.object({
  id: z.string(),
  to: z.string(),
  status: z.string(),
  note: z.string().optional(),
});

/** The tool's success result (`{ id, to, status, note? }`), or undefined for an error or odd text. */
export function parseSendResult(result: OutgoingRow["result"]) {
  if (!result || result.isError) return undefined;
  try {
    const r = sendResultSchema.safeParse(JSON.parse(result.content));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

const STATUS_TEXT: Record<string, string> = {
  hibernated: "hibernated",
  queued: "queued",
  rate_limited: "rate-limited",
  errored: "errored",
};

/** The agent's own `send_message` call as a message block (UI design §2.5): direction in the sender
 *  line, the body as written, and a past-tense footer. */
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
  const names = useAgentNames();
  const input = row.call.input as { to: string; body: string; urgent?: unknown };
  const sent = parseSendResult(row.result);
  const target = sent?.to ?? input.to;
  const bare = target.replace(/^@/, "");
  // A result names agents bare and humans `@handle`; an unanswered call is only the argument.
  const toAgent = sent
    ? !sent.to.startsWith("@")
    : !target.startsWith("@") || (bare !== "humans" && !!names?.has(bare));
  const recipient = `@${bare}`;
  const failed = row.result?.isError === true;
  const toolRow: Extract<Row, { kind: "tool" }> = {
    kind: "tool",
    seq: row.seq,
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
      aria-label={`Message from @${slug} to ${recipient}`}
      className="rounded-lg border border-border px-3 py-2"
    >
      <div className="mb-1 flex flex-wrap items-center gap-x-2 text-[0.8125rem] leading-[1.125rem]">
        <span className="font-mono text-foreground">@{slug}</span>
        <ArrowRight aria-hidden="true" className="size-3.5 text-muted-foreground" />
        <span>
          {toAgent ? (
            <AgentLink slug={bare} />
          ) : (
            <span className="font-mono text-foreground">{recipient}</span>
          )}
        </span>
        {input.urgent === true && (
          <span className="rounded-sm border border-border px-1.5 text-foreground">Urgent</span>
        )}
        <time
          dateTime={row.at}
          title={new Date(row.at).toLocaleString()}
          className="text-muted-foreground"
        >
          {formatTime(row.at)}
        </time>
      </div>
      <ClampedMarkdown source={input.body} />
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
        {failed || row.denial ? (
          <span className="flex items-center gap-1.5">
            <CircleAlert aria-hidden="true" className="size-3.5 shrink-0 text-destructive" />
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {row.denial ? denialText(row.denial.reason) : row.result?.content}
            </span>
          </span>
        ) : (
          <Footer row={row} sent={sent} toAgent={toAgent} bare={bare} />
        )}
        {toAgent && sent && (
          <Link
            to="/agents/$slug"
            params={{ slug: sent.to }}
            search={{ message: sent.id }}
            aria-label={`View this message in @${sent.to}'s session`}
            className={`text-foreground ${LINK_CLASS}`}
          >
            View in session
          </Link>
        )}
        <button
          type="button"
          aria-expanded={showCall}
          onClick={onToggleCall}
          className="underline-offset-4 hover:underline"
        >
          {showCall ? "Hide tool call" : "Show tool call"}
        </button>
      </div>
      {showCall && (
        <div className="mt-2">
          <ToolCallRow row={toolRow} expanded onToggle={onToggleCall} rowProps={{}} />
        </div>
      )}
    </article>
  );
}

function Footer({
  row,
  sent,
  toAgent,
  bare,
}: {
  row: OutgoingRow;
  sent: ReturnType<typeof parseSendResult>;
  toAgent: boolean;
  bare: string;
}) {
  if (!row.result) return <span>{row.turnOpen ? "Sending…" : "Not sent"}</span>;
  if (!sent) return <span>Sent</span>;
  if (!toAgent) return <span>Sent to the inbox</span>;
  const state = STATUS_TEXT[sent.status];
  return (
    <>
      <span>
        {state ? (
          <>
            Sent · <span className="font-mono">@{bare}</span> was {state}
          </>
        ) : (
          "Sent"
        )}
      </span>
      {sent.note && <span>{sent.note}</span>}
    </>
  );
}
