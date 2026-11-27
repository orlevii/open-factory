/**
 * Who is acting: a signed-in human or an agent, by principal. Required wherever a write needs attribution or the agent
 * policy. `ref` is the principal's ref, which the factory writes as the actor's mention.
 */
export type Actor =
  | { kind: "human"; ref: string; handle: string }
  | { kind: "agent"; id: string; ref: string; handle: string };

/** How the actor is named in a stored body or event: its mention, `<@ref>`, so the handle shown is always current. */
export const actorMention = (a: Actor): string => `<@${a.ref}>`;

/** How the org bus names the actor: its ref, which the browser resolves to the current handle. */
export const actorBy = (a: Actor): string => a.ref;
