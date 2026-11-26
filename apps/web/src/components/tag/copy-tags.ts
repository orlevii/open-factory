import type { ClipboardEvent } from "react";

const CHIP = "[data-of-tag]";
const BLOCKS = new Set([
  "P",
  "LI",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "PRE",
  "BLOCKQUOTE",
  "TR",
]);

/** The fragment's text, one line break between blocks. */
function textOf(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  const el = node as Element;
  if (el.nodeName === "BR") return "\n";
  const inner = Array.from(node.childNodes, textOf).join("");
  return BLOCKS.has(el.nodeName) ? `${inner}\n` : inner;
}

/**
 * An `onCopy` for a container that may hold chips: the selection goes to `text/plain` with `@handle` and to
 * `text/html` with `<span data-of-tag="ref">@handle</span>` (a composer paste reads these back into tags).
 * A selection with no chip in it is left to the browser.
 */
export function onCopyTags(e: ClipboardEvent<HTMLElement>): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !e.clipboardData) return;
  const wrap = document.createElement("div");
  wrap.append(sel.getRangeAt(0).cloneContents());
  const chips = wrap.querySelectorAll<HTMLElement>(CHIP);
  if (chips.length === 0) return;
  for (const chip of chips) {
    const span = document.createElement("span");
    span.dataset.ofTag = chip.dataset.ofTag ?? "";
    span.textContent = `@${chip.dataset.handle ?? ""}`;
    chip.replaceWith(span);
  }
  e.clipboardData.setData("text/plain", textOf(wrap).replace(/\n$/, ""));
  e.clipboardData.setData("text/html", wrap.innerHTML);
  e.preventDefault();
}
