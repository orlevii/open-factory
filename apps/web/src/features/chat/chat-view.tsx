import { useCallback, useLayoutEffect, useRef } from "react";
import { readViewPosition, useRememberPosition } from "@/features/agents/view-memory";

/** A bottom within this many px counts as pinned (the session's slack). */
const SLACK = 8;

/** The chat thread. The thread itself is built in the next tasks; this holds the view's place: the
 *  scroller whose position and pin the per-slug memory keeps across a Chat/Session switch. */
export function ChatView({ slug }: { slug: string; messageId?: string | undefined }) {
  const scroller = useRef<HTMLDivElement>(null);
  const isPinned = useCallback(() => {
    const el = scroller.current;
    return !el || el.scrollHeight - el.clientHeight - el.scrollTop <= SLACK;
  }, []);
  useRememberPosition(slug, "chat", scroller, isPinned);
  // Restored on mount: a view left unpinned comes back where it was.
  useLayoutEffect(() => {
    const left = readViewPosition(slug, "chat");
    if (scroller.current && left && !left.pinned) scroller.current.scrollTop = left.top;
  }, [slug]);
  return (
    <div
      ref={scroller}
      data-chat-view
      className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6"
    />
  );
}
