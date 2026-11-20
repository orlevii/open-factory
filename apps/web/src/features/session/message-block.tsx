import { Clock } from "lucide-react";
import { useState } from "react";
import { Markdown } from "@/components/markdown/markdown";
import { formatTime } from "./format";

/** Incoming input (UI design §4.1): on the ground with a 1px rule edge and 6px radius, never a bubble.
 *  The sender line is generic (`from` + badges), never the raw envelope XML. */
export function MessageBlock(props: {
  from: string;
  body: string;
  urgent?: boolean;
  at?: string;
  queued?: { reason?: string };
  failed?: boolean;
}) {
  const { from, body, urgent, at, queued, failed } = props;
  return (
    <div
      className={`rounded-lg border px-3 py-2 ${queued ? "border-dashed border-input" : "border-border"}`}
    >
      <div className="mb-1 flex flex-wrap items-center gap-x-2 text-[0.8125rem] leading-[1.125rem]">
        <span className="font-mono text-foreground">{from}</span>
        {urgent && (
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

/** Bodies over 40 lines clamp with "Show all" (bodies may be up to 64 KB). */
function ClampedMarkdown({ source }: { source: string }) {
  const [all, setAll] = useState(false);
  const lines = source.split("\n");
  if (lines.length <= CLAMP_LINES || all) return <Markdown source={source} />;
  return (
    <>
      <Markdown source={lines.slice(0, CLAMP_LINES).join("\n")} />
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
