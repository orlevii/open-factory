import { memo, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { BlockMarkdown } from "@/components/markdown/block-markdown";
import { SpeakerLine, useSpeakers } from "./speaker-line";

/** The muted line under a block cut at 64 KiB, live and persisted alike (U3 §11.2, Q44). */
export const CAP_LINE = "Cut at 64 KB; the full text stayed with the agent.";

/**
 * While a non-collapsed selection intersects `ref`'s element, the text shown when it began; frames
 * still land in the session state and the block catches up in one commit when the selection collapses
 * (U3 §11.4). Active only for a live block: a persisted one never changes under a selection.
 */
function useHeldWhileSelected(
  ref: RefObject<HTMLElement | null>,
  text: string,
  live: boolean,
): string {
  const [held, setHeld] = useState<string>();
  // Adjusted during render: a block that stopped being live drops what it held.
  if (!live && held !== undefined) setHeld(undefined);
  // The text on screen, read when a selection starts (written after commit, never during render).
  const shown = useRef(text);
  useLayoutEffect(() => {
    shown.current = held ?? text;
  });
  useEffect(() => {
    if (!live) return;
    const onSelection = () => {
      const el = ref.current;
      const sel = document.getSelection();
      const inside =
        !!el &&
        !!sel &&
        !sel.isCollapsed &&
        sel.rangeCount > 0 &&
        sel.getRangeAt(0).intersectsNode(el);
      setHeld((h) => (inside ? (h ?? shown.current) : undefined));
    };
    document.addEventListener("selectionchange", onSelection);
    return () => document.removeEventListener("selectionchange", onSelection);
  }, [live, ref]);
  return live && held !== undefined ? held : text;
}

/**
 * The agent's text, live or persisted, as one component (U3 §11.4): a live block is an `AgentText`
 * with `live`, so the persisted row that retires it (same key) keeps its element, its DOM and any
 * selection inside, with the same height and no fade. Primitives only, so a frame that doesn't change
 * this block skips it.
 */
export const AgentText = memo(function AgentText({
  text,
  live = false,
  capped = false,
  head,
  at,
}: {
  text: string;
  live?: boolean;
  capped?: boolean;
  /** Opens a speaker line (U3 §7.2). */
  head: boolean;
  at?: string;
}) {
  const body = useRef<HTMLDivElement>(null);
  const shown = useHeldWhileSelected(body, text, live);
  const handle = useSpeakers().sessionAgent?.handle ?? "…";
  return (
    <>
      {/* The turn's first text, and the first after an incoming message (U3 §7.2). */}
      {head && <SpeakerLine from={handle} fromKind="agent" self at={at} />}
      <div ref={body} dir="auto">
        <BlockMarkdown text={shown} live={live} />
      </div>
      {capped && (
        <p data-cap-line className="mt-1 text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
          {CAP_LINE}
        </p>
      )}
    </>
  );
});
