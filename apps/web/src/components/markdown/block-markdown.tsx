import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { OpenFenceCode } from "./code-block";
import { Markdown, NewTabNote, PROSE_CLASS, VARIANT_CLASS } from "./markdown";
import { splitBlocks } from "./split-blocks";
import { prepareTail } from "./stream-tail";

/** An open block longer than this re-parses at most every `THROTTLE_MS` (U3 §11.4). */
const BIG_TAIL = 4096;
const THROTTLE_MS = 250;
const CONTAINER_CLASS = `${PROSE_CLASS}${VARIANT_CLASS.detail}`;

type Split = { text: string; blocks: string[] };

/** `splitBlocks(text)`, re-splitting only the last block when live text grew from the previous text:
 *  a split never happens inside a fence, so everything before the last block's start is final. */
function splitFrom(text: string, prev: Split | undefined): Split {
  const last = prev?.blocks.at(-1);
  if (prev && last !== undefined && text.startsWith(prev.text)) {
    const start = prev.text.lastIndexOf(last);
    if (start >= 0) {
      const rest = splitBlocks(text.slice(start)).blocks;
      return { text, blocks: [...prev.blocks.slice(0, -1), ...rest] };
    }
  }
  return { text, blocks: splitBlocks(text).blocks };
}

/** The blocks of `text`; incremental while `live`. The previous split is read from a ref written
 *  after commit, so a discarded or doubled render recomputes the same result. */
function useBlocks(text: string, live: boolean): string[] {
  const prev = useRef<Split | undefined>(undefined);
  const split = useMemo(
    () => (live ? splitFrom(text, prev.current) : { text, blocks: splitBlocks(text).blocks }),
    [text, live],
  );
  useLayoutEffect(() => {
    prev.current = split;
  }, [split]);
  return split.blocks;
}

/** The open block's text as rendered: every committed frame under 4 KB; above it, one trailing
 *  update at most every 250ms (never a state update per frame). Keyed by the block's index, so a
 *  new block never shows the previous one's text. */
function useTail(index: number, tail: string, live: boolean): string {
  const big = live && tail.length > BIG_TAIL;
  const [shown, setShown] = useState<{ index: number; text: string } | undefined>(undefined);
  const lastAt = useRef(0);
  useEffect(() => {
    if (!big) return;
    const wait = Math.max(0, lastAt.current + THROTTLE_MS - Date.now());
    const t = setTimeout(() => {
      lastAt.current = Date.now();
      setShown({ index, text: tail });
    }, wait);
    return () => clearTimeout(t);
  }, [big, index, tail]);
  // Crossing 4 KB, the text parsed last is not held yet: the current text until the first update.
  return big && shown?.index === index && shown.text.length > BIG_TAIL ? shown.text : tail;
}

/**
 * Agent text, live or persisted, through one renderer (U3 §11.4): one memoized bare `Markdown` per
 * block, all siblings in one `.prose-of .prose-of-detail` container, so margins and loose lists are
 * the same in both. While `live`, the last block goes through `prepareTail`: an open fence is plain
 * code, unclosed marks are closed and marker-only lines wait for their newline. Blocks are keyed by
 * index with the same element type, so a completed block's element is reused as text grows.
 */
export const BlockMarkdown = memo(function BlockMarkdown({
  text,
  live = false,
}: {
  text: string;
  live?: boolean;
}) {
  const noteId = useId();
  const blocks = useBlocks(text, live);
  const lastIndex = blocks.length - 1;
  const tailText = useTail(lastIndex, blocks[lastIndex] ?? "", live);
  const tail = useMemo(() => (live ? prepareTail(tailText) : undefined), [live, tailText]);
  return (
    <>
      <div className={CONTAINER_CLASS}>
        {blocks.map((block, i) => {
          if (i < lastIndex || !tail)
            // biome-ignore lint/suspicious/noArrayIndexKey: blocks only grow at the end; the index is their identity
            return <Markdown key={i} bare noteId={noteId} source={block} />;
          if (tail.kind === "markdown")
            // biome-ignore lint/suspicious/noArrayIndexKey: as above
            return <Markdown key={i} bare noteId={noteId} source={tail.source} />;
          // biome-ignore lint/suspicious/noArrayIndexKey: as above
          return <OpenFence key={i} noteId={noteId} lead={tail.lead} slices={tail.slices} />;
        })}
      </div>
      {/* After the prose, never in it: as its last child it would keep the last block's bottom margin */}
      <NewTabNote id={noteId} />
    </>
  );
});

/** The tail's open fence: the block's markdown before it, then the plain code. */
function OpenFence({
  noteId,
  lead,
  slices,
}: {
  noteId: string;
  lead: string | undefined;
  slices: string[];
}) {
  return (
    <>
      {lead ? <Markdown bare noteId={noteId} source={lead} /> : null}
      <OpenFenceCode slices={slices} />
    </>
  );
}
