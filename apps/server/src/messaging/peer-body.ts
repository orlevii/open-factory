import type { Envelope } from "@open-factory/shared";
import { mentionOf, scanMentions } from "@open-factory/shared/mentions";

type Subject = NonNullable<Envelope["subject"]>;
export type PeerLeft = NonNullable<Subject["left"]>;
/**
 * `by`: the actor's mention, `<@ref>`, when an agent caused the change (human-made changes carry none, spec I7 §8.2).
 * `left.to` and `left.by` are mentions too, or `@factory` for the idle TTL.
 */
export type PeerBodyEvent =
  | { kind: "peer_joined"; by?: string }
  | { kind: "peer_left"; left: PeerLeft; by?: string };

/**
 * The one owner of peer-event bodies (S6 spec §10.2, S7 §9.1): the Router writes them with `peerBody`, and the runtime
 * reads how the subject left back with `peerLeftOf` (no column stores it). Keep the two in step.
 */
export function peerBody(
  subject: { ref: string; displayName: string },
  relation: Subject["relation"],
  change: PeerBodyEvent,
  recipientRef: string,
): string {
  const who = `${mentionOf(subject.ref)} (${subject.displayName})`;
  // The recipient needn't be told about its own act.
  const by = change.by && change.by !== mentionOf(recipientRef) ? `, by ${change.by}` : "";
  if (change.kind === "peer_joined") return `${who} joined as your ${relation}${by}.`;
  const { left } = change;
  if (left.reason === "terminated") return `${who} left: terminated ${terminatedBy(left.by)}.`;
  if (left.reason === "archived") return `${who} left: archived${by}.`;
  return `${who} left: now reports to ${left.to}${by}.`;
}

/** The idle TTL's `terminated_by` (S7 §10.3) is the `@factory` word; any other terminator is a mention. */
const FACTORY = "@factory";
const TTL_WORDS = "after 3 days without activity";
const terminatedBy = (by: string): string => (by === FACTORY ? TTL_WORDS : `by ${by}`);

/** Anchored at the end: the display name before it is human text and may contain anything. */
const LEFT =
  / left: (?:(archived)|now reports to (\S+?)|terminated (?:by (\S+?)|(after 3 days without activity)))(?:, by \S+?)?\.$/;

/** A mention, as the body wrote it: the one token of `text`, or undefined when it holds none. */
const mentionIn = (text: string): string | undefined => {
  const [t] = scanMentions(text).tokens;
  return t ? mentionOf(t.ref) : undefined;
};

/**
 * How the subject left, read back from a `peer_left` body written by `peerBody`; undefined for any other text. The
 * principals come back as the mentions the body holds (`<@ref>`), or `@factory` for the idle TTL.
 */
export function peerLeftOf(body: string): PeerLeft | undefined {
  const m = LEFT.exec(body);
  if (!m) return undefined;
  if (m[1]) return { reason: "archived" };
  if (m[4]) return { reason: "terminated", by: FACTORY };
  if (m[3]) {
    const by = mentionIn(m[3]);
    return by ? { reason: "terminated", by } : undefined;
  }
  const to = mentionIn(m[2] ?? "");
  return to ? { reason: "moved", to } : undefined;
}
