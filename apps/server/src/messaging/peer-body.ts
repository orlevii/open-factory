import type { Envelope } from "@open-factory/shared";

type Subject = NonNullable<Envelope["subject"]>;
export type PeerLeft = NonNullable<Subject["left"]>;
export type PeerBodyEvent = { kind: "peer_joined" } | { kind: "peer_left"; left: PeerLeft };

/**
 * The one owner of peer-event bodies (S6 spec §10.2, S7 §9.1): the Router writes them with `peerBody`, and the runtime
 * reads how the subject left back with `peerLeftOf` (no column stores it). Keep the two in step.
 */
export function peerBody(
  subject: { slug: string; displayName: string },
  relation: Subject["relation"],
  change: PeerBodyEvent,
): string {
  const who = `@${subject.slug} (${subject.displayName})`;
  if (change.kind === "peer_joined") return `${who} joined as your ${relation}.`;
  const { left } = change;
  if (left.reason === "terminated") return `${who} left: terminated ${terminatedBy(left.by)}.`;
  if (left.reason === "archived") return `${who} left: archived.`;
  return `${who} left: now reports to ${left.to ? `@${left.to}` : "the humans"}.`;
}

/** The TTL sweep's `terminated_by` (S7 §10.3). */
const FACTORY = "@factory";
const TTL_WORDS = "after 3 days without activity";

/** Who terminated it, as prose: `@factory` is the TTL, a `@handle` stays as is, a spawner's bare slug gains its `@`. */
function terminatedBy(by: string): string {
  if (by === FACTORY) return TTL_WORDS;
  return `by ${by.startsWith("@") ? by : `@${by}`}`;
}

/** Anchored at the end: the display name before it is human text and may contain anything. */
const LEFT =
  / left: (?:(archived)|now reports to (?:@([^\s.]+)|(the humans))|terminated (?:by (@[^\s.]+)|(after 3 days without activity)))\.$/;

/**
 * How the subject left, read back from a `peer_left` body written by `peerBody`; undefined for any other text. A
 * terminator reads back as `@name` (prose can't tell a spawner's slug from a human's handle) or `@factory` for the TTL.
 */
export function peerLeftOf(body: string): PeerLeft | undefined {
  const m = LEFT.exec(body);
  if (!m) return undefined;
  if (m[1]) return { reason: "archived" };
  if (m[4]) return { reason: "terminated", by: m[4] };
  if (m[5]) return { reason: "terminated", by: FACTORY };
  return { reason: "moved", to: m[2] ?? null };
}
