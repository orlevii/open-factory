import { type ReactNode, type RefObject, useLayoutEffect, useRef } from "react";
import { COPY_PROPS } from "./caret-menu";
import type { TagRange } from "./tag-ranges";

/**
 * The layer behind a tag field that paints each tag range with the chip's fill. It lays the same text out
 * as the textarea (the same font, padding and wrap, through `COPY_PROPS`, narrower by the scrollbar gutter)
 * and follows its scroll; its own text is transparent, so only the fills show, and the textarea's text, caret,
 * IME and spellcheck stay the browser's. Decorative: `aria-hidden`.
 */
export function TagHighlighter({
  text,
  ranges,
  box,
}: {
  text: string;
  ranges: readonly TagRange[];
  box: RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
}) {
  const layer = useRef<HTMLDivElement>(null);

  // Layout and scroll follow the field; the text it shows is already this render's.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new text can change the field's size and scrollbar
  useLayoutEffect(() => {
    const el = box.current;
    const mirror = layer.current;
    if (!el || !mirror) return;
    const sync = () => {
      const style = getComputedStyle(el);
      for (const p of COPY_PROPS) mirror.style[p] = style[p];
      const gutter = Math.max(0, el.offsetWidth - el.clientWidth - 2 * el.clientLeft);
      mirror.style.paddingRight = `${Number.parseFloat(style.paddingRight) + gutter}px`;
      mirror.scrollTop = el.scrollTop;
      mirror.scrollLeft = el.scrollLeft;
    };
    sync();
    const follow = () => {
      mirror.scrollTop = el.scrollTop;
      mirror.scrollLeft = el.scrollLeft;
    };
    el.addEventListener("scroll", follow, { passive: true });
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(sync);
    resize?.observe(el);
    return () => {
      el.removeEventListener("scroll", follow);
      resize?.disconnect();
    };
  }, [box, text]);

  const parts: ReactNode[] = [];
  let at = 0;
  for (const r of ranges) {
    if (r.start > at) parts.push(text.slice(at, r.start));
    parts.push(
      <mark
        key={`${r.start}:${r.ref}`}
        className="rounded-[4px] bg-muted text-transparent dark:bg-selected"
      >
        {text.slice(r.start, r.end)}
      </mark>,
    );
    at = r.end;
  }
  parts.push(text.slice(at));
  return (
    <div
      ref={layer}
      aria-hidden="true"
      data-tag-highlighter
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden whitespace-pre-wrap break-words text-transparent"
    >
      {parts}
      {/* A trailing newline only takes a line when something follows it. */}
      {"​"}
    </div>
  );
}
