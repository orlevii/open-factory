import { schema } from "@open-factory/db";
import { and, eq } from "drizzle-orm";
import type { EventBus } from "../agents/event-bus.ts";
import type { EventStore, PendingRow } from "../agents/event-store.ts";
import { ApiError } from "../errors.ts";
import type { LoopGuard } from "./loop-guard.ts";
import type { Router } from "./router.ts";

const { loopHolds, messages, principals } = schema;

/** Spec §6.6: a human resumes a held pair. */
export class LoopResume {
  constructor(
    private readonly d: {
      store: EventStore;
      guard: LoopGuard;
      router: Pick<Router, "handOffResumed">;
      bus: Pick<EventBus, "publishAll">;
    },
  ) {}

  /** Opens the hold's window again and sends its held rows on; resolves with how many. */
  async resume(id: string, userId: string): Promise<{ sentOn: number }> {
    const rows = await this.d.store.transaction(async (tx) => {
      const [hold] = await tx.select().from(loopHolds).where(eq(loopHolds.id, id));
      if (!hold) throw new ApiError(404, "not_found", "Not found");
      // The pair lock comes before the row lock, always: a send that saw the hold open has committed its held row
      // by the time this reads them.
      await this.d.guard.lockPairs(tx, [{ a: hold.agentA, b: hold.agentB }]);
      const [locked] = await tx.select().from(loopHolds).where(eq(loopHolds.id, id)).for("update");
      if (!locked) throw new ApiError(404, "not_found", "Not found");
      if (locked.resumedAt) {
        const [by] = locked.resumedBy
          ? await tx
              .select({ handle: principals.handle })
              .from(principals)
              .where(eq(principals.id, locked.resumedBy))
          : [];
        throw new ApiError(409, "already_resumed", "This pair was already resumed.", {
          resumedBy: by ? `@${by.handle}` : "",
          resumedAt: locked.resumedAt.toISOString(),
        });
      }
      await tx
        .update(loopHolds)
        .set({ resumedAt: this.d.store.clock(), resumedBy: userId })
        .where(eq(loopHolds.id, id));
      const flipped = await tx
        .update(messages)
        .set({ state: "pending" })
        .where(and(eq(messages.loopHoldId, id), eq(messages.state, "loop_held")))
        .returning({ id: messages.id });
      const out: PendingRow[] = [];
      for (const { id: mid } of flipped) out.push(await this.d.store.pendingRow(mid, tx));
      return out.sort(
        (x, y) => x.createdAt.getTime() - y.createdAt.getTime() || (x.id < y.id ? -1 : 1),
      );
    });
    this.d.router.handOffResumed(rows);
    this.d.bus.publishAll({ type: "inbox_changed" });
    return { sentOn: rows.length };
  }
}
