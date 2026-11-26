import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { onCopyTags } from "../tag/copy-tags";
import { OpenFenceCode } from "./code-block";
import { Markdown, NewTabNote, PROSE_CLASS, VARIANT_CLASS } from "./markdown";
import { splitBlocks } from "./split-blocks";
import { prepareTail } from "./stream-tail";

/** An open block longer than this re-parses at most every `THROTTLE_MS` (U3 §11.4). */
const BIG_TAIL = 4096;
const THROTTLE_MS = 250;
const CONTAINER_CLASS = `${PROSE_CLASS}${VARIANT_CLASS.detail}`;

type Split = { text: string; blocks: string[]; starts: number[] };

const fullSplit = (text: string): Split => ({ text, ...splitBlocks(text) });

/** `splitBlocks(text)`, re-splitting only from the second-to-last block when live text grew from
 *  the previous text. The boundary before the last block depends on that block's first line, which
 *  may still be arriving ("2" before "2. b"); the boundary before the second-to-last is final, since
 *  a later block can only start after the last one's first line ended. */
function splitFrom(text: string, prev: Split | undefined): Split {
  if (!prev || prev.blocks.length < 2 || !text.startsWith(prev.text)) return fullSplit(text);
  const from = prev.starts.at(-2) as number;
  const rest = splitBlocks(text.slice(from));
  return {
    text,
    blocks: [...prev.blocks.slice(0, -2), ...rest.blocks],
    starts: [...prev.starts.slice(0, -2), ...rest.starts.map((s) => s + from)],
  };
}

/** The blocks of `text`; incremental while `live`. The previous split is read from a ref written
 *  after commit, so a discarded or doubled render recomputes the same result. */
function useBlocks(text: string, live: boolean): string[] {
  const prev = useRef<Split | undefined>(undefined);
  const split = useMemo(
    () => (live ? splitFrom(text, prev.current) : fullSplit(text)),
    [text, live],
  );
  useLayoutEffect(() => {
    prev.current = split;
  }, [split]);
  return split.blocks;
}

/** Whether live text really ends in a newline after its last block (blocks are trimmed). */
const ENDS_IN_NEWLINE = /\n\s*$/;

type Tail = { index: number; text: string; newline: boolean };

/** The open block as rendered: every committed frame under 4 KB; above it, one trailing update at
 *  most every 250ms (never a state update per frame). Keyed by the block's index, so a new block
 *  never shows the previous one's text. */
function useTail(current: Tail, live: boolean): Tail {
  const big = live && current.text.length > BIG_TAIL;
  const [shown, setShown] = useState<Tail | undefined>(undefined);
  const lastAt = useRef(0);
  const { index, text, newline } = current;
  useEffect(() => {
    if (!big) return;
    const wait = Math.max(0, lastAt.current + THROTTLE_MS - Date.now());
    const t = setTimeout(() => {
      lastAt.current = Date.now();
      setShown({ index, text, newline });
    }, wait);
    return () => clearTimeout(t);
  }, [big, index, text, newline]);
  // Crossing 4 KB, the text parsed last is not held yet: the current text until the first update.
  return big && shown?.index === index && shown.text.length > BIG_TAIL ? shown : current;
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
  const newline = live && ENDS_IN_NEWLINE.test(text);
  const shown = useTail({ index: lastIndex, text: blocks[lastIndex] ?? "", newline }, live);
  const tail = useMemo(
    () => (live ? prepareTail(shown.text, shown.newline) : undefined),
    [live, shown.text, shown.newline],
  );
  return (
    <>
      <div className={CONTAINER_CLASS} onCopy={onCopyTags}>
        {blocks.map((block, i) => {
          const open = tail && i === lastIndex ? tail : undefined;
          return (
            <Block
              // biome-ignore lint/suspicious/noArrayIndexKey: blocks only grow at the end; the index is their identity
              key={i}
              noteId={noteId}
              source={open ? (open.kind === "markdown" ? open.source : (open.lead ?? "")) : block}
              slices={open?.kind === "fence" ? open.slices : undefined}
            />
          );
        })}
      </div>
      {/* After the prose, never in it: as its last child it would keep the last block's bottom margin */}
      <NewTabNote id={noteId} />
    </>
  );
});

/** One block, completed or open: always its markdown first (an open fence's lead), then, while a
 *  fence is open, the plain code. One element type for every block, so the markdown part (a lead
 *  paragraph too) keeps its element as a fence opens and closes and as the block completes. */
const Block = memo(function Block({
  noteId,
  source,
  slices,
}: {
  noteId: string;
  source: string;
  slices: string[] | undefined;
}) {
  return (
    <>
      <Markdown bare noteId={noteId} source={source} />
      {slices ? <OpenFenceCode slices={slices} /> : null}
    </>
  );
});
