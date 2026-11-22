import { useLayoutEffect, useRef, useState } from "react";

type Props = {
  text: string;
  /** A file name: once its last segment alone is too wide, it cuts from the start, so the
   *  extension stays. */
  keepEnd?: boolean;
  /** The head never collapses to nothing: about four characters of it stay, and the tail truncates
   *  first below that (a chip's file name). Only while the name overflows: one that fits renders
   *  whole, with no gap between its parts. */
  headMin?: boolean;
};

/** Long paths: the head shrinks with an ellipsis, then the last segment (only when it alone is too
 *  wide). Text with no inner "/" (a handle) splits at its middle, so "@marketing-team" reads
 *  "@ma…ng-team": its head and tail both stay. */
export function MiddleTruncate({ text, keepEnd = false, headMin = false }: Props) {
  if (headMin) return <FittedMiddleTruncate text={text} keepEnd={keepEnd} />;
  return (
    <span className="flex min-w-0">
      <Split text={text} keepEnd={keepEnd} headMin={false} />
      <span className="sr-only">{text}</span>
    </span>
  );
}

function Split({ text, keepEnd, headMin }: Required<Props>) {
  const slash = text.lastIndexOf("/");
  const i = slash > 0 ? slash : Math.ceil(text.length / 2);
  const head = text.slice(0, i);
  const tail = text.slice(i);
  const tailCap = headMin ? "max-w-[calc(100%-4ch)]" : "max-w-full";
  return (
    <>
      <span aria-hidden="true" className={headMin ? "min-w-[4ch] truncate" : "truncate"}>
        {head}
      </span>
      {/* The head goes first; the tail truncates only once the head is gone and it alone is too wide. */}
      {keepEnd ? (
        // A right-to-left box puts the ellipsis at the start; the text inside stays left-to-right.
        <span aria-hidden="true" dir="rtl" className={`${tailCap} shrink-0 truncate text-left`}>
          <span dir="ltr">{tail}</span>
        </span>
      ) : (
        <span aria-hidden="true" className={`${tailCap} shrink-0 truncate`}>
          {tail}
        </span>
      )}
    </>
  );
}

/** `headMin`: the whole name while it fits; the split (with the head minimum) only once it overflows,
 *  measured after layout and again when the box changes size (re-verification N3). */
function FittedMiddleTruncate({ text, keepEnd }: { text: string; keepEnd: boolean }) {
  const box = useRef<HTMLSpanElement>(null);
  const [split, setSplit] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new text is measured again
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    // Plain: the whole name overflows. Split: a part is cut, else the whole name would fit again.
    const measure = () =>
      setSplit(
        [...el.querySelectorAll<HTMLElement>("[aria-hidden=true]")].some(
          (n) => n.scrollWidth > n.clientWidth + 0.5,
        ),
      );
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, split]);
  return (
    <span ref={box} className="flex min-w-0">
      {split ? (
        <Split text={text} keepEnd={keepEnd} headMin />
      ) : (
        <span aria-hidden="true" className="truncate">
          {text}
        </span>
      )}
      <span className="sr-only">{text}</span>
    </span>
  );
}
