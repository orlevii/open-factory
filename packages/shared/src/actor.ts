/** Who is acting: a signed-in human or an agent. Required wherever a write needs attribution or the agent policy. */
export type Actor = { kind: "human"; handle: string } | { kind: "agent"; id: string; slug: string };

/** How events and notices name the actor: `@handle` or `@slug`. */
export const actorBy = (a: Actor): string => `@${a.kind === "human" ? a.handle : a.slug}`;
