import type { RefObject } from "react";
import { useEffect } from "react";

export type AgentView = "chat" | "session";
export type ViewPosition = { top: number; pinned: boolean };

/** Per agent, where each view was left (spec §6.1): module-level, so it outlives the view's remount
 *  at a switch and nothing renders when it changes. Reset on a reload, which is fine. */
const memory = new Map<string, Partial<Record<AgentView, ViewPosition>>>();

export const readViewPosition = (slug: string, view: AgentView): ViewPosition | undefined =>
  memory.get(slug)?.[view];

export function writeViewPosition(slug: string, view: AgentView, position: ViewPosition): void {
  memory.set(slug, { ...memory.get(slug), [view]: position });
}

/** Forgets every place (a test's router starts from a clean slate). */
export const clearViewPositions = () => memory.clear();

/** Records the scroller's position and pin on every scroll (a plain write: no state, no render). */
export function useRememberPosition(
  slug: string,
  view: AgentView,
  scroller: RefObject<HTMLElement | null>,
  isPinned: () => boolean,
  /** False while the view shows something that isn't its place (a deep-link window). */
  enabled = true,
): void {
  useEffect(() => {
    const el = scroller.current;
    if (!el || !enabled) return;
    const write = () => writeViewPosition(slug, view, { top: el.scrollTop, pinned: isPinned() });
    el.addEventListener("scroll", write, { passive: true });
    return () => el.removeEventListener("scroll", write);
  }, [slug, view, scroller, isPinned, enabled]);
}
