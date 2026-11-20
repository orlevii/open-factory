import type { Db, ScheduleRow } from "@open-factory/db";
import { countRuns, latestAtOrBefore, nextRun } from "@open-factory/shared";
import type { RuntimeLog } from "../agents/agent-runtime.ts";
import type { EventBus } from "../agents/event-bus.ts";
import type { EventStore } from "../agents/event-store.ts";
import type { AgentRuntimes } from "../agents/runtimes.ts";
import { backoffMs, DUE_BATCH, LATE_MS, TICK_MAX_MS, TICK_MIN_MS } from "./limits.ts";
import type { ScheduleStore } from "./schedule-store.ts";

type Timer = ReturnType<typeof setTimeout>;

export interface SchedulerDeps {
  db: Db;
  store: Pick<EventStore, "pendingRow">;
  schedules: ScheduleStore;
  runtimes: Pick<AgentRuntimes, "deliver">;
  bus: Pick<EventBus, "publishAll">;
  log: RuntimeLog;
  /** The injected clock: every query passes this instant as a parameter, never Postgres `now()` (spec §7.3). */
  now: () => Date;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (t: Timer) => void;
}

/** The result of the occurrence math of §8.1 step 3. */
export type Firing = { due: Date; missed: number; late: boolean; next: Date | null };

/**
 * `due` is the latest occurrence at or before now, `missed` the occurrences in `[next_run_at, now]` (capped at 1,000;
 * a one-shot is 1), `late` is "more than a minute after due", and `next` the first occurrence strictly after now.
 */
export function planFiring(row: ScheduleRow, now: Date): Firing {
  const runAt = row.runAt;
  if (!row.cron) {
    const due = runAt ?? now;
    return { due, missed: 1, late: now.getTime() - due.getTime() > LATE_MS, next: null };
  }
  const start = row.nextRunAt ?? now;
  const latest = latestAtOrBefore(row.cron, row.timezone, now);
  const due = latest && latest.getTime() >= start.getTime() ? latest : start;
  const missed = Math.max(1, countRuns(row.cron, row.timezone, start, now));
  return {
    due,
    missed,
    late: now.getTime() - due.getTime() > LATE_MS,
    next: nextRun(row.cron, row.timezone, now),
  };
}

const isDeadlock = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "40P01" || e?.cause?.code === "40P01";
};

type Outcome = { progress: boolean; handoff?: string };

/**
 * Factory schedules on a durable `next_run_at` and one in-process timer (S9 spec §7.3, §8). Each firing is one
 * transaction (agent row FOR SHARE, then the schedule `SKIP LOCKED`, then the message write); the hand-off to the
 * runtime happens after the commit and is never awaited inside it.
 */
export class Scheduler {
  private timer: Timer | undefined;
  private started = false;
  private stopped = false;
  private running: Promise<void> | undefined;
  private again = false;
  private readonly handoffs = new Set<Promise<unknown>>();
  private readonly setTimer: NonNullable<SchedulerDeps["setTimer"]>;
  private readonly clearTimer: NonNullable<SchedulerDeps["clearTimer"]>;

  constructor(private readonly d: SchedulerDeps) {
    this.setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = d.clearTimer ?? ((t) => clearTimeout(t));
  }

  /** Armed once at start (after boot reconciliation): the first tick finds whatever came due while the factory was down. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.arm(0);
  }

  /** The closing latch: no new tick; a tick in progress finishes its transaction and skips its hand-offs. */
  stop(): void {
    this.stopped = true;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = undefined;
  }

  /** After a committed change: recompute the timer. A no-op before `start()` and after `stop()`. */
  rearm(): void {
    if (!this.started || this.stopped || this.running) return;
    void this.rearmFromDb();
  }

  /** Resolves when no tick is running and every hand-off promise of the ticks so far has settled. */
  async idle(): Promise<void> {
    for (;;) {
      await this.running;
      if (this.handoffs.size) await Promise.allSettled([...this.handoffs]);
      if (!this.running && !this.handoffs.size) return;
    }
  }

  /** One tick; a tick requested while one runs is run right after it (never overlapped). Never rejects. */
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.loop().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async loop(): Promise<void> {
    let progress = false;
    do {
      this.again = false;
      try {
        progress = await this.runTick();
      } catch (err) {
        progress = false;
        this.d.log.error({ err }, "a scheduler tick failed");
      }
    } while (this.again && !this.stopped);
    await this.rearmAfterTick(progress);
  }

  private arm(ms: number): void {
    if (this.stopped) return;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      void this.tick();
    }, ms);
  }

  /** `clamp(earliest - now, progress ? 0 : TICK_MIN_MS, TICK_MAX_MS)`; 60 s when nothing is scheduled. */
  private async rearmAfterTick(progress: boolean): Promise<void> {
    if (this.stopped) return;
    let ms = TICK_MAX_MS;
    try {
      const at = await this.d.schedules.earliest(this.d.db);
      if (at) ms = at.getTime() - this.d.now().getTime();
    } catch (err) {
      this.d.log.error({ err }, "re-arming the scheduler failed");
    }
    this.arm(Math.min(Math.max(ms, progress ? 0 : TICK_MIN_MS), TICK_MAX_MS));
  }

  private async rearmFromDb(): Promise<void> {
    try {
      const at = await this.d.schedules.earliest(this.d.db);
      if (this.stopped || this.running) return;
      const ms = at ? at.getTime() - this.d.now().getTime() : TICK_MAX_MS;
      this.arm(Math.min(Math.max(ms, 0), TICK_MAX_MS));
    } catch (err) {
      this.d.log.error({ err }, "re-arming the scheduler failed");
    }
  }

  /** Returns whether any schedule made progress (fired, advanced, skipped for an archived target, or was removed). */
  private async runTick(): Promise<boolean> {
    const now = this.d.now();
    const due = await this.d.schedules.dueIds(this.d.db, now, DUE_BATCH);
    let progress = false;
    for (const s of due) {
      if (this.stopped) break;
      const o = await this.fire(s.id, s.targetAgentId);
      if (o.progress) progress = true;
      if (o.handoff) this.handOff(o.handoff);
    }
    // A full batch: the rest fire on the immediately following tick.
    if (due.length === DUE_BATCH && progress) this.again = true;
    return progress;
  }

  private async fire(id: string, targetAgentId: string): Promise<Outcome> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const o = await this.fireOnce(id, targetAgentId);
        if (o.progress) this.d.bus.publishAll({ type: "schedules_changed" });
        return o;
      } catch (err) {
        lastErr = err;
        if (!isDeadlock(err)) break;
      }
    }
    await this.fail(id, lastErr);
    return { progress: false };
  }

  private async fail(id: string, err: unknown): Promise<void> {
    this.d.log.error({ err, schedule: id }, "firing a schedule failed");
    try {
      const now = this.d.now();
      const [row] = await this.d.schedules.recordById(this.d.db, id).then((r) => (r ? [r] : []));
      const failCount = row?.failCount ?? 0;
      await this.d.schedules.recordFailure(
        this.d.db,
        id,
        failCount,
        new Date(now.getTime() + backoffMs(failCount)),
      );
    } catch (e) {
      this.d.log.error({ err: e, schedule: id }, "recording a firing failure failed");
    }
  }

  private async fireOnce(id: string, targetAgentId: string): Promise<Outcome> {
    const now = this.d.now();
    const out = await this.d.db.transaction(async (tx): Promise<Outcome> => {
      const [target] = await this.d.schedules.lockAgents(tx, [
        { id: targetAgentId, mode: "share" },
      ]);
      const row = await this.d.schedules.lockForFiring(tx, id);
      if (!row) return { progress: false };
      const stillDue =
        !row.deletedAt &&
        !row.pausedAt &&
        row.nextRunAt !== null &&
        row.nextRunAt.getTime() <= now.getTime() &&
        (!row.retryAt || row.retryAt.getTime() <= now.getTime()) &&
        row.targetAgentId === targetAgentId;
      if (!stillDue || !target) return { progress: false };
      if (target.terminatedAt) {
        // Cannot happen (termination deletes its schedules); if read, delete the schedule.
        await this.d.schedules.update(tx, row.id, {
          deletedAt: now,
          nextRunAt: null,
          updatedAt: now,
        });
        return { progress: true };
      }
      let f: Firing;
      try {
        f = planFiring(row, now);
      } catch (err) {
        // croner threw on a stored expression: pause it so it can't spin every tick.
        this.d.log.error(
          { err, schedule: id },
          "a stored cron pattern can't be evaluated; pausing it",
        );
        await this.d.schedules.update(tx, row.id, { pausedAt: now, updatedAt: now });
        return { progress: true };
      }
      const base = { nextRunAt: f.next, failCount: 0, retryAt: null, updatedAt: now };
      if (target.archivedAt) {
        // Q9, R5: no row, `last_fired_at` unchanged; the schedule stays and moves on.
        await this.d.schedules.update(tx, row.id, base);
        return { progress: true };
      }
      await this.d.schedules.update(tx, row.id, { ...base, lastFiredAt: now });
      const msg = await this.d.schedules.upsertFiring(tx, {
        schedule: row,
        due: f.due,
        missed: f.missed,
        late: f.late,
        now,
      });
      return { progress: true, ...(msg ? { handoff: msg } : {}) };
    });
    return out;
  }

  /** After the commit: hand the row to its runtime. Never awaited by the tick, never thrown, skipped once stopped. */
  private handOff(messageId: string): void {
    if (this.stopped) return;
    const p = (async () => {
      const row = await this.d.store.pendingRow(messageId);
      if (this.stopped) return;
      await this.d.runtimes.deliver(row, "agent", "scheduled");
    })().catch((err: unknown) =>
      this.d.log.error({ err, message: messageId }, "handing a scheduled message over failed"),
    );
    this.handoffs.add(p);
    void p.finally(() => this.handoffs.delete(p));
  }
}
