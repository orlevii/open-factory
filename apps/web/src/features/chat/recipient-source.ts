import type { QueryClient } from "@tanstack/react-query";
import type { CompletionItem, CompletionSource } from "@/components/composer/composer";
import { type MentionAgent, mentionOpensAt, rankMentions } from "@/components/composer/mentions";
import { agentsListQueryOptions } from "@/features/session/api";
import { MAX_RECIPIENTS } from "@/lib/drafts";

export const AT_LABEL = "Add a recipient";
export const MENU_NOTE = "Adds a recipient · Esc keeps it as text";
export const FULL_NOTE = `A message goes to at most ${MAX_RECIPIENTS} agents.`;
const NO_AGENTS: MentionAgent[] = [];
const HANDLE_TAIL = /^[A-Za-z0-9-]*/;

type Held = {
  /** The chat's agent. */
  slug: string;
  /** The recipients added so far (read when the menu asks, never captured). */
  added(): readonly string[];
  /** Adds one; false when it was refused (files attached). */
  add(slug: string): boolean;
};

/**
 * The chat composer's `@` source (I1 §6.6): live agents only, without the chat's agent and the ones
 * already added. Accepting adds the agent as a recipient and removes the typed `@token`; a typed
 * `@name` that isn't accepted stays text. Built once per chat, so the composer's `memo` holds.
 */
export function recipientSource(qc: QueryClient, h: Held): CompletionSource {
  const full = () => h.added().length + 1 >= MAX_RECIPIENTS;
  return {
    trigger: "@",
    label: AT_LABEL,
    opensAt: mentionOpensAt,
    items(query) {
      if (full()) return [];
      const skip = new Set([h.slug, ...h.added()]);
      return rankMentions(query, {
        agents:
          qc.getQueryData<MentionAgent[]>(agentsListQueryOptions("exclude").queryKey) ?? NO_AGENTS,
        humans: [],
        me: undefined,
      })
        .filter((m) => m.kind === "agent" && !skip.has(m.handle))
        .map(
          (m): CompletionItem => ({
            id: m.handle,
            label: `Add @${m.handle} as recipient`,
            detail: m.name,
            group: "agents",
            avatar: {
              slug: m.handle,
              ...(m.kind === "agent"
                ? { template: m.template, avatarVersion: m.avatarVersion, color: m.color }
                : {}),
            },
          }),
        );
    },
    menuNote: (rows) => (full() ? FULL_NOTE : rows > 0 ? MENU_NOTE : undefined),
    accept(item, text, from, caret) {
      // A refused add leaves the text as it was.
      if (!h.add(item.id)) return { text, caret };
      const end = caret + (HANDLE_TAIL.exec(text.slice(caret))?.[0].length ?? 0);
      const before = text.slice(0, from);
      let rest = text.slice(end);
      // One space goes with the token, not two joined.
      if (before.endsWith(" ") && rest.startsWith(" ")) rest = rest.slice(1);
      return { text: before + rest, caret: before.length };
    },
  };
}
