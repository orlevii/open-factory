import type { AgentRecord } from "../principals/principal-store.ts";

/** A live agent always has a credential (CHECK agents_live_credential); only a terminated row can lose it. */
export function liveCredentialId(row: Pick<AgentRecord, "handle" | "credentialId">): string {
  if (!row.credentialId)
    throw new Error(
      `@${row.handle} has no credential: it was terminated and its credential deleted`,
    );
  return row.credentialId;
}
