import { expiryState } from "@/features/settings/sign-in/expiry";
import type { InboxItem } from "./api";

/** What a factory item is "about": the agent's `@handle`, or a credential's name (mono, no `@`). */
export function aboutOf(item: InboxItem): string | undefined {
  return item.link.kind === "credential" ? item.link.name : item.about && `@${item.about}`;
}

export type CredentialLine = { tone: "muted" | "warning" | "crimson"; text: string };

/** A credential item's live state line (spec §8.6): from `expiresAt` against `now`, never the stored
 *  body. `now` is a parameter so a memoised row computes from its prop only. */
export function credentialLine(item: InboxItem, now: Date): CredentialLine {
  const c = item.credential;
  if (!c?.current) return { tone: "muted", text: "Signed in again" };
  const ex = expiryState(c.expiresAt, now);
  return ex.tone === "none"
    ? { tone: "muted", text: item.preview }
    : { tone: ex.tone, text: ex.text };
}
