import { useState } from "react";
import { CopyButton } from "@/components/copy-feedback";
import { Markdown } from "@/components/markdown/markdown";
import { ShowAll } from "./message-block";
import { CodePlate } from "./quiet-line";
import { SpeakerLine } from "./speaker-line";

/** A command's text is cut here until Show all, like a message body (U3 §7.6, 4,000 characters). */
const CLAMP_CHARS = 4000;

/**
 * A command a human ran (U3 §13.3): drawn like their message, a card with the speaker line and the
 * suffix "ran a command", the command itself in mono, clamped with Show all.
 */
export function CommandBlock({ by, text, at }: { by: string; text: string; at: string }) {
  const [all, setAll] = useState(false);
  const cut = !all && text.length > CLAMP_CHARS;
  return (
    <div data-message-block className="rounded-lg border border-border bg-card py-2 pr-9 pl-3">
      <SpeakerLine from={by} at={at}>
        <span className="text-muted-foreground">ran a command</span>
      </SpeakerLine>
      <p dir="auto" className="font-mono text-sm [overflow-wrap:anywhere]">
        {cut ? `${text.slice(0, CLAMP_CHARS)}…` : text}
      </p>
      {cut && <ShowAll onShow={() => setAll(true)} />}
    </div>
  );
}

/** Output that reads as markdown; the rest (`/usage`, `/cost`, `/stats`) is a code plate. */
const MARKDOWN_OUTPUT = new Set(["context"]);

/**
 * What a local command printed (U3 §13.3): `/context` as markdown (its tables scroll in `.md-table`),
 * `/usage` and `/cost` as a code plate; both with Copy.
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
          <Markdown source={text} variant="work" />
        </div>
      ) : (
        <CodePlate>{text}</CodePlate>
      )}
      <CopyButton text={text} />
    </div>
  );
}
