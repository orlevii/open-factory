/** Who ended an agent (S7 UI design §4.4), from the `terminated` event's `by` or `subject.left.by`:
 *  a bare slug is an agent (an `AgentLink`), a `@handle` a human (plain mono), and
 *  `@factory` the inactivity TTL ("after 3 days without activity", never "@factory"). Callers
 *  render it, since each places it in its own sentence. */
export type By =
  | { kind: "agent"; slug: string }
  | { kind: "human"; handle: string }
  | { kind: "ttl" };

export function formatBy(by: string): By {
  if (by === "@factory") return { kind: "ttl" };
  if (by.startsWith("@")) return { kind: "human", handle: by };
  return { kind: "agent", slug: by };
}
