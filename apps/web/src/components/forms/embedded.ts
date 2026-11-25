/** Marks an embedded form (an inline prerequisite). Its group answers Escape through `collapseEmbeddedOnEscape`. */
export const EMBEDDED_ATTR = "data-embedded-add";
const SELECTOR = `[${EMBEDDED_ATTR}]`;
export const COLLAPSE_EVENT = "embedded-collapse";

/**
 * An overlay's `onEscapeKeyDown` (Radix listens on the document in the capture phase, before any field sees the key):
 * when focus is inside an embedded form, Escape collapses only that form. The overlay stays open, and nothing happens
 * while the form is busy (`data-busy`: a code exchange or a save is in flight).
 */
export function collapseEmbeddedOnEscape(e: Event) {
  const at = document.activeElement;
  const group = at instanceof Element ? at.closest<HTMLElement>(SELECTOR) : null;
  if (!group) return;
  e.preventDefault();
  if (group.hasAttribute("data-busy")) return;
  group.dispatchEvent(new Event(COLLAPSE_EVENT));
}
