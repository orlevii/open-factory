import { type Db, schema } from "@open-factory/db";
import { tagOf, unknownRefError } from "@open-factory/shared/tags";
import { eq } from "drizzle-orm";
import type { RuntimeLog } from "../agents/agent-runtime.ts";
import type { EventStore, PendingRow } from "../agents/event-store.ts";
import type { AgentRuntimes } from "../agents/runtimes.ts";
import { ApiError } from "../errors.ts";
import type { TerminatePort } from "../mcp/tools/terminate-agent.ts";
import type { Router } from "../messaging/router.ts";
import { type Principal, principalById } from "../principals/principal-store.ts";

const { agents } = schema;

/**
 * Termination (S7 §8): the one path for `terminate_agent` (`by` = the spawner), the UI route (`by` = the human)
 * and the reaper (`by` = null, the factory). Latch first, then one transaction, so nothing can write to or start the agent
 * between the commit and the latch.
 */
export class TerminateService implements TerminatePort {
  constructor(
    private readonly d: {
      db: Db;
      store: EventStore;
      runtimes: AgentRuntimes;
      router: Pick<Router, "snapshot" | "persistPeerEvents" | "handOffRows">;
      log: RuntimeLog;
    },
  ) {}

  /**
   * `terminate_agent` (spec §7.3): only the caller's own spawned agents; anything else reads the same. A failure is one
   * sentence that says what to do.
   */
  async terminateChild(
    callerId: string,
    targetArg: string,
  ): Promise<
    { ok: true; slug: string; tag: string; warning?: string } | { ok: false; message: string }
  > {
    const found = await this.d.store.agentByArg(targetArg);
    if (found.kind === "unknown_ref") return { ok: false, message: unknownRefError(found.ref) };
    const a = found.kind === "agent" ? found.row : undefined;
    if (a?.kind !== "ephemeral" || a.reportsTo !== callerId)
      return {
        ok: false,
        message: `@${found.kind === "agent" ? found.handle : found.name} isn't an agent you spawned.`,
      };
    try {
      const caller = await principalById(this.d.db, callerId);
      if (!caller) throw new Error(`caller ${callerId} is not a principal`);
      await this.terminate(a.id, caller);
    } catch (err) {
      this.d.log.error({ err, agent: a.slug }, "terminating a spawned agent failed");
      return { ok: false, message: `@${a.slug} couldn't be terminated; try again.` };
    }
    return {
      ok: true,
      slug: a.slug,
      tag: await this.d.store.agentTag(a.id),
      ...(found.kind === "agent" && found.warning ? { warning: found.warning } : {}),
    };
  }

  /**
   * Spec §8 steps 1–3: the provisional latch (unless the caller latched it already, inside the agent's job), one
   * transaction under the lock order of §5.7, the committed latch, the peer rows' hand-off, then the stop job in the
   * background. Resolves once the transaction has committed and the latch is set; a terminated agent is a no-op.
   */
  async terminate(
    agentId: string,
    by: Pick<Principal, "id" | "kind" | "ref" | "handle"> | null,
    o: { latched?: boolean } = {},
  ): Promise<{ status: "terminated" }> {
    // These guards run before the provisional latch and its unmark-on-failure try below, on purpose: nothing is latched
    // yet. A caller that latched already (`latched: true`) owns its own unmark if one of them throws (a new latched caller
    // must not rely on terminate() to unmark for it).
    const rt = await this.d.runtimes.load(agentId);
    if (!rt) throw new ApiError(404, "agent_not_found", "No such agent");
    if (rt.agent.kind !== "ephemeral")
      throw new ApiError(409, "not_ephemeral", "Only spawned agents can be terminated.");
    if (!o.latched) rt.markTerminated({ committed: false });
    // The terminator as the `terminated` event and the peer notices write it: a tag, or `@factory` for the TTL.
    const terminator = by ? tagOf(by.ref) : "@factory";
    let peerRows: PendingRow[] = [];
    let rejectedFor: string[] = [];
    let already: boolean;
    try {
      already = await this.d.db.transaction(async (tx) => {
        // Lock order (§5.7): the spawner's row, then the child's, both FOR NO KEY UPDATE (never FOR UPDATE: message and
        // event inserts take KEY SHARE on them); agent rows before any message row.
        const spawnerId = rt.agent.reportsTo;
        const [spawner] = spawnerId
          ? await tx
              .select({ id: agents.id })
              .from(agents)
              .where(eq(agents.id, spawnerId))
              .for("no key update")
          : [];
        const [row] = await tx
          .select({ terminatedAt: agents.terminatedAt })
          .from(agents)
          .where(eq(agents.id, agentId))
          .for("no key update");
        if (!row) throw new ApiError(404, "agent_not_found", "No such agent");
        if (row.terminatedAt) return true;
        // The neighborhood before the change, read in the transaction (a stale pool read could miss a sibling).
        const before = await this.d.router.snapshot(tx, agentId);
        rejectedFor = await this.d.store.terminateRows(tx, agentId, by?.id ?? null);
        // The spawner gets no row about its own act (§9.1): it has the tool result.
        peerRows = await this.d.router.persistPeerEvents(
          tx,
          agentId,
          { kind: "left", reason: "terminated", by: terminator },
          before,
          { excludeManager: spawner !== undefined && by?.id === spawner.id },
        );
        return false;
      });
    } catch (err) {
      // §8 step 2 on failure: what arrived during the window is delivered normally.
      rt.unmarkTerminated();
      throw err;
    }
    rt.markTerminated({ committed: true });
    rt.chatChanged(rejectedFor);
    if (already) return { status: "terminated" };
    // A row whose insert committed after the transaction's reject-pending update (its sender read the agent live, and
    // READ COMMITTED doesn't show the transaction that row) is pending still: reject it now. Any later hand-off finds
    // the committed latch, which rejects it.
    rt.chatChanged(
      await this.d.store.rejectPending(agentId).catch((err: unknown) => {
        this.d.log.error(
          { err, agent: rt.agent.slug },
          "rejecting late rows to a terminated agent failed",
        );
        return [];
      }),
    );
    this.d.router.handOffRows(peerRows);
    // §8 step 3: the stop and the container removal continue in the background; the status frame reports their end.
    void rt
      .terminateStop(terminator)
      .catch((err: unknown) =>
        this.d.log.error({ err, agent: rt.agent.slug }, "stopping a terminated agent failed"),
      );
    return { status: "terminated" };
  }
}
