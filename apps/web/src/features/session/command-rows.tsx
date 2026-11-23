import { Clock } from "lucide-react";
import { useState } from "react";
import { CopyButton } from "@/components/copy-feedback";
import { InlineOutcome } from "@/components/inline-outcome";
import { Markdown } from "@/components/markdown/markdown";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ShowAll } from "./message-block";
import { CodePlate } from "./quiet-line";
import type { RawPending } from "./rows";
import { useSendPhase } from "./send-phase";
import { SpeakerLine } from "./speaker-line";

/** A command's text is cut here until Show all, like a message body (U3 §7.6, 4,000 characters). */
const CLAMP_CHARS = 4000;

const RAW_NOTE = "text-muted-foreground";

/**
 * Raw input a human sent (I1 §5): a card with the speaker line and "· raw", the text as typed
 * (`pre-wrap`, mono when it is a slash command), clamped with Show all. The same component serves the
 * block from "Sending" to the `operator_input` row, so `pending` changes while the node stays: sending
 * (the muted body, "Sending…" once slow), queued (dashed, "Runs after the current turn" once not
 * young, Cancel on yours) and delivered (no `pending`).
 */
export function CommandBlock({
  by,
  text,
  at,
  pending,
}: {
  by: string;
  text: string;
  at: string;
  pending?: RawPending | undefined;
}) {
  const [all, setAll] = useState(false);
  const { young, slow } = useSendPhase(pending?.sending === true);
  const cut = !all && text.length > CLAMP_CHARS;
  const sending = pending?.sending === true;
  const queued = pending !== undefined && !sending;
  const status = sending ? (
    slow ? (
      <span className="flex items-center gap-1 text-muted-foreground">
        <Spinner size="text" />
        Sending…
      </span>
    ) : null
  ) : queued && !young ? (
    <span className="flex items-center gap-1 text-muted-foreground">
      <Clock aria-hidden="true" className="size-3.5" />
      Runs after the current turn
    </span>
  ) : null;
  const cancel = pending?.onCancel;
  return (
    <div
      data-message-block
      {...(sending ? { role: "group", "aria-label": "Sending" } : {})}
      className={`rounded-lg border bg-card py-2 pr-9 pl-3 ${queued ? "border-dashed border-input" : "border-border"}`}
    >
      <SpeakerLine
        from={by}
        fromKind="human"
        at={at || undefined}
        status={status}
        action={
          cancel ? (
            <Button type="button" variant="ghost" size="xs" onClick={cancel}>
              Cancel
            </Button>
          ) : undefined
        }
      >
        <span className={RAW_NOTE}>· raw</span>
      </SpeakerLine>
      <p
        dir="auto"
        className={`text-sm whitespace-pre-wrap [overflow-wrap:anywhere] ${text.startsWith("/") ? "font-mono" : ""} ${sending ? "text-muted-foreground" : ""}`}
      >
        {cut ? `${text.slice(0, CLAMP_CHARS)}…` : text}
      </p>
      {cut && <ShowAll onShow={() => setAll(true)} />}
      {pending?.error && (
        <div className="pt-1">
          <InlineOutcome tone="error">Couldn't cancel: {pending.error}</InlineOutcome>
        </div>
      )}
    </div>
  );
}

/** Output that reads as markdown; the rest (`/usage`, `/cost`, `/stats`) is a code plate. */
const MARKDOWN_OUTPUT = new Set(["context"]);

/**
 * What a local command printed (U3 §13.3): `/context` as markdown (its tables scroll in `.md-table`),
 * `/usage` and `/cost` as a code plate; both with Copy. `/context` lists names a repo controls (skills,
 * MCP servers, memory files), so its markdown is untrusted: a mermaid fence shows as code.
 */
export function CommandOutput({
  command,
  text,
  rowProps,
}: {
  command: string;
  text: string;
  rowProps: Record<string, unknown>;
}) {
  return (
    <div {...rowProps} data-command-output className="group/code relative min-w-0">
      {MARKDOWN_OUTPUT.has(command) ? (
        <div className="pr-8">
          <Markdown source={text} variant="work" untrusted />
        </div>
      ) : (
        <CodePlate>{text}</CodePlate>
      )}
      <CopyButton text={text} />
    </div>
  );
}
