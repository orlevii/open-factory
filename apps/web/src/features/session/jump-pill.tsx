import { ArrowDown } from "lucide-react";
import { memo, useState } from "react";
import { isSpeechRow, type Row } from "./rows";

const NOTHING = { speech: 0, other: false } as const;

/** What arrived since the reader left the bottom (U3 §8.2): speech rows (a handed-off row replaced
 *  something already on screen, so it isn't new), and whether anything else did. Rows are in seq
 *  order, so only the tail is walked. */
export function arrivedSince(
  rows: Row[],
  seenSeq: number | undefined,
  handedOff: ReadonlySet<string>,
): { speech: number; other: boolean } {
  if (seenSeq === undefined) return NOTHING;
  let speech = 0;
  let other = false;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i] as Row;
    if (row.seq <= seenSeq) break;
    if (handedOff.has(row.key)) continue;
    if (isSpeechRow(row)) speech++;
    else other = true;
  }
  return { speech, other };
}

const label = (speech: number, other: boolean, windowed: boolean) =>
  speech > 0
    ? `${speech > 99 ? "99+" : speech} new ${speech === 1 ? "message" : "messages"}`
    : other && !windowed
      ? "New output"
      : "Jump to latest";

/**
 * The one Jump to latest (U3 §8.2): always mounted so it can fade, centred on the 52rem column by
 * its parent. Hidden, it is `inert` and takes no pointer. Label changes are instant while shown; while
 * it hides it keeps the last label it showed, so the exit never flashes a new label or width.
 */
export const JumpPill = memo(function JumpPill({
  shown,
  speech,
  other,
  windowed,
  onJump,
}: {
  shown: boolean;
  speech: number;
  other: boolean;
  windowed: boolean;
  onJump(): void;
}) {
  const now = label(speech, other, windowed);
  // Adjusted during render (no effect): the label follows only while shown.
  const [shownLabel, setShownLabel] = useState(now);
  if (shown && shownLabel !== now) setShownLabel(now);
  const text = shown ? now : shownLabel;
  return (
    <button
      type="button"
      data-shown={shown ? "" : undefined}
      inert={!shown}
      onClick={onJump}
      className="jump-pill absolute bottom-0 left-1/2 inline-flex h-8 w-max max-w-[calc(100%-2rem)] items-center gap-1.5 rounded-lg border border-float-edge bg-popover px-3 text-[0.8125rem] font-medium text-popover-foreground tabular-nums select-none hover:bg-muted"
    >
      <ArrowDown aria-hidden="true" className="size-4 shrink-0" />
      <span className="truncate">{text}</span>
    </button>
  );
});
