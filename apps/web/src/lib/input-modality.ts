import { type Ref, type RefCallback, type RefObject, useCallback } from "react";

let last: "keyboard" | "pointer" = "pointer";

/** Capture-phase listeners: an overlay opened right after a key press was opened from the keyboard. */
export function installInputModality(doc: Document = document): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Shift" && e.key !== "Meta" && e.key !== "Control" && e.key !== "Alt")
      last = "keyboard";
  };
  const onPointer = () => {
    last = "pointer";
  };
  doc.addEventListener("keydown", onKey, true);
  doc.addEventListener("pointerdown", onPointer, true);
  return () => {
    doc.removeEventListener("keydown", onKey, true);
    doc.removeEventListener("pointerdown", onPointer, true);
    last = "pointer";
  };
}

export const lastInputModality = () => last;

/** Ref callback for overlay Content/Overlay nodes. Radix and Vaul mount those nodes once per opening, so
 *  this runs per opening: a keyboard-opened overlay is stamped `data-instant` for that whole opening
 *  (DESIGN.md → Motion → Frequency). Module-level, hence stable: React never re-calls it on re-render. */
export function stampInstant(node: HTMLElement | null) {
  if (node && last === "keyboard") node.setAttribute("data-instant", "");
}

/** Composes a consumer's ref with `stampInstant`; stable while `ref` is. */
export function useStampedRef<T extends HTMLElement>(ref?: Ref<T>): RefCallback<T> {
  return useCallback(
    (node: T | null) => {
      stampInstant(node);
      if (typeof ref === "function") return ref(node);
      if (ref) (ref as RefObject<T | null>).current = node;
    },
    [ref],
  );
}
