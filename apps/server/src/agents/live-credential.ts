import type { AgentRow } from "@open-factory/db";

/** A live agent always has a credential (CHECK agents_live_credential); only a terminated row can lose it. */
export function liveCredentialId(row: Pick<AgentRow, "slug" | "credentialId">): string {
  if (!row.credentialId)
    throw new Error(`@${row.slug} has no credential: it was terminated and its credential deleted`);
  return row.credentialId;
}
