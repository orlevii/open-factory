/**
 * Commands the palette sends to the open session page, as plain module state so the app shell
 * doesn't import the session's components (they stay in the session route's chunk).
 */

/** Each mounted composer's focus, by slug; and a request for a composer not mounted yet. */
const composerFocus = new Map<string, () => void>();
let wanted: { slug: string; at: number } | null = null;
/** A request waits this long for its composer to mount (a session page still loading). */
const WANTED_MS = 5000;

/** Focuses the agent's composer: now if it is mounted, else as soon as it mounts (the palette's
 *  ⇧Enter opens the session and focuses the box). */
export function requestComposerFocus(slug: string) {
  const focus = composerFocus.get(slug);
  wanted = focus ? null : { slug, at: Date.now() };
  focus?.();
}

/** Registers a mounted composer's focus (and honours a pending request); returns the remover. */
export function registerComposerFocus(slug: string, focus: () => void): () => void {
  composerFocus.set(slug, focus);
  if (wanted?.slug === slug) {
    if (Date.now() - wanted.at < WANTED_MS) focus();
    wanted = null;
  }
  return () => {
    if (composerFocus.get(slug) === focus) composerFocus.delete(slug);
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

/** Each mounted timeline's re-pin, by slug: sending from the composer follows the bottom again. */
const timelineRepin = new Map<string, () => void>();

/** Scrolls the agent's timeline to the bottom and pins it (U3 §8.1); a no-op if none is mounted. */
export function repinTimeline(slug: string) {
  timelineRepin.get(slug)?.();
}

export function registerTimelineRepin(slug: string, repin: () => void): () => void {
  timelineRepin.set(slug, repin);
  return () => {
    if (timelineRepin.get(slug) === repin) timelineRepin.delete(slug);
  };
}
