/**
 * Commands the palette sends to the open session page, as plain module state so the app shell
 * doesn't import the session's components (they stay in the session route's chunk).
 */

/** Each mounted composer's focus, by agentRef; and a request for a composer not mounted yet. */
const composerFocus = new Map<string, () => void>();
let wanted: { agentRef: string; at: number } | null = null;
/** A request waits this long for its composer to mount (a session page still loading). */
const WANTED_MS = 5000;

/** Focuses the agent's composer: now if it is mounted, else as soon as it mounts (the palette's
 *  ⇧Enter opens the session and focuses the box). */
export function requestComposerFocus(agentRef: string) {
  const focus = composerFocus.get(agentRef);
  wanted = focus ? null : { agentRef, at: Date.now() };
  focus?.();
}

/** Registers a mounted composer's focus (and honours a pending request); returns the remover. */
export function registerComposerFocus(agentRef: string, focus: () => void): () => void {
  composerFocus.set(agentRef, focus);
  if (wanted?.agentRef === agentRef) {
    if (Date.now() - wanted.at < WANTED_MS) focus();
    wanted = null;
  }
  return () => {
    if (composerFocus.get(agentRef) === focus) composerFocus.delete(agentRef);
  };
}

/** The mounted session page's Agent details opener (one session page at a time). */
let detailsOpener: (() => void) | null = null;

/** Opens Agent details on the current session page (the palette's action); a no-op elsewhere. */
export function openAgentDetails() {
  detailsOpener?.();
}

export function registerAgentDetailsOpener(open: () => void): () => void {
  detailsOpener = open;
  return () => {
    if (detailsOpener === open) detailsOpener = null;
  };
}

/** Each mounted timeline's re-pin, by agentRef: sending from the composer follows the bottom again. */
const timelineRepin = new Map<string, () => void>();

/** Scrolls the agent's timeline to the bottom and pins it (U3 §8.1); a no-op if none is mounted. */
export function repinTimeline(agentRef: string) {
  timelineRepin.get(agentRef)?.();
}

export function registerTimelineRepin(agentRef: string, repin: () => void): () => void {
  timelineRepin.set(agentRef, repin);
  return () => {
    if (timelineRepin.get(agentRef) === repin) timelineRepin.delete(agentRef);
  };
}
