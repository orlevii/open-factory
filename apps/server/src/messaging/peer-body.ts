import type { Envelope } from "@open-factory/shared";

type Subject = NonNullable<Envelope["subject"]>;
export type PeerLeft = NonNullable<Subject["left"]>;
export type PeerBodyEvent = { kind: "peer_joined" } | { kind: "peer_left"; left: PeerLeft };

/**
 * The one owner of peer-event bodies (spec §10.2): the Router writes them with `peerBody`, and the runtime reads the
 * move target back with `peerLeftOf` (no column stores it). Keep the two in step.
 */
export function peerBody(
  subject: { slug: string; displayName: string },
  relation: Subject["relation"],
  change: PeerBodyEvent,
): string {
  const who = `@${subject.slug} (${subject.displayName})`;
  if (change.kind === "peer_joined") return `${who} joined as your ${relation}.`;
  const { left } = change;
  if (left.reason === "archived") return `${who} left: archived.`;
  return `${who} left: now reports to ${left.to ? `@${left.to}` : "the humans"}.`;
}

/** Anchored at the end: the display name before it is human text and may contain anything. */
const LEFT = / left: (?:(archived)|now reports to (?:@([^\s.]+)|(the humans)))\.$/;

/** How the subject left, read back from a `peer_left` body written by `peerBody`; undefined for any other text. */
export function peerLeftOf(body: string): PeerLeft | undefined {
  const m = LEFT.exec(body);
  if (!m) return undefined;
  if (m[1]) return { reason: "archived" };
  return { reason: "moved", to: m[2] ?? null };
}
