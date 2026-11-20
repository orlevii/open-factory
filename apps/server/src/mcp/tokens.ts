import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const hash = (t: string) => createHash("sha256").update(t).digest();

/**
 * Per-process agent tokens (spec §5.2). Only `sha256(token)` is kept, in memory; the plaintext
 * is returned once by `mint` and never logged, evented or put in an error. Nothing is persisted:
 * a server restart ends every agent process, so no token outlives this map. Only the agent
 * listener reads it; the human REST API never consults it.
 */
export class AgentTokens {
  private readonly byHash = new Map<
    string,
    { agentId: string; generation: number; digest: Buffer }
  >();
  private gen = 0;

  mint(agentId: string): { token: string; generation: number } {
    const token = randomBytes(32).toString("base64url");
    const digest = hash(token);
    this.gen += 1;
    this.byHash.set(digest.toString("hex"), { agentId, generation: this.gen, digest });
    return { token, generation: this.gen };
  }

  verify(presented: string | undefined): { agentId: string; generation: number } | undefined {
    if (!presented) return undefined;
    const d = hash(presented);
    const e = this.byHash.get(d.toString("hex"));
    if (!e || !timingSafeEqual(e.digest, d)) return undefined;
    return { agentId: e.agentId, generation: e.generation };
  }

  revoke(agentId: string, generation: number): void {
    for (const [k, v] of this.byHash) {
      if (v.agentId === agentId && v.generation === generation) this.byHash.delete(k);
    }
  }

  revokeAll(): void {
    this.byHash.clear();
  }
}
