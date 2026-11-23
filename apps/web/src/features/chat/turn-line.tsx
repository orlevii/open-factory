import type { ChatEntry } from "@open-factory/shared";
import { Link } from "@tanstack/react-router";
import { Check, CircleAlert, Square } from "lucide-react";
import { memo, useState } from "react";
import { MiddleTruncate } from "@/components/middle-truncate";
import { Elapsed } from "@/features/session/activity-line";
import { formatTime } from "@/features/session/format";
import { ROW_GUTTER } from "@/features/session/timeline-item";

type Outcome = Extract<ChatEntry, { kind: "turn_outcome" }>["outcome"];
const OUTCOME_TEXT: Record<Outcome, { suffix: string; Icon: typeof Check }> = {
  no_reply: { suffix: " finished without replying", Icon: Check },
  stopped: { suffix: " was stopped before replying", Icon: Square },
  error: { suffix: " hit an error before replying", Icon: CircleAlert },
};

/** "Ada hit an error before replying": the line's sentence, also what the live region announces. */
export const outcomeSentence = (name: string, outcome: Outcome) =>
  `${name}${OUTCOME_TEXT[outcome].suffix}`;

/**
 * The thread's status line (I1 §6.4): "[tooth] 42s · Ada is working · Open session" while a turn that
 * read your message runs, and in the same box, "[icon] Ada finished without replying · Open session"
 * once it ended. One node under one key (`turn:<key>`), so the outcome replacing the working line
 * keeps its element. The elapsed time is its own component: a tick renders nothing else.
 */
export const TurnLine = memo(function TurnLine({
  slug,
  name,
  at,
  outcome,
  eventSeq,
  live,
  gap,
}: {
  slug: string;
  name: string;
  /** `working.since`, or the turn's `endedAt`. */
  at: string;
  /** Absent while the turn runs. */
  outcome?: Outcome | undefined;
  eventSeq?: number | null | undefined;
  /** Appeared by a live frame: fades in once (the working line, like the activity line). */
  live: boolean;
  gap: string;
}) {
  // Decided once, at mount: the outcome that replaces the working line is this same node and keeps what it had.
  const [fades] = useState(live);
  const text = outcome ? OUTCOME_TEXT[outcome] : undefined;
  return (
    <p
      data-status-line={outcome ?? "working"}
      {...(fades ? { "data-live": "" } : {})}
      className={`flex h-6 min-w-0 items-center ${ROW_GUTTER} ${gap} text-[0.8125rem] leading-[1.125rem] text-muted-foreground`}
    >
      <span
        aria-hidden="true"
        className="mr-2 inline-flex size-3 shrink-0 items-center justify-center"
      >
        {text ? <text.Icon className="size-3" /> : <span className="of-tooth" />}
      </span>
      {!outcome && (
        <>
          <Elapsed since={at} />
          <span className="shrink-0 whitespace-pre"> · </span>
        </>
      )}
      <span className="flex min-w-0 items-baseline">
        <span className="flex min-w-0">
          <MiddleTruncate text={name} />
        </span>
        <span className="shrink-0 whitespace-pre">{text?.suffix ?? " is working"}</span>
      </span>
      <span className="shrink-0 whitespace-pre"> · </span>
      <Link
        to="/agents/$slug/session"
        params={{ slug }}
        search={eventSeq != null ? { event: eventSeq } : {}}
        aria-label={`Open session at ${formatTime(at)}`}
        className="shrink-0 underline underline-offset-4 decoration-muted-foreground hover:text-foreground hover:decoration-ring"
      >
        Open session
      </Link>
    </p>
  );
});
