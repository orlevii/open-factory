import { type Db, type ScheduleRow, schema } from "@open-factory/db";
import {
  formatKey,
  formatOffsetIso,
  isValidZone,
  MSG,
  minGapMinutes,
  nextRun,
  parseAt,
  parseKey,
  SCHEDULE_BODY_MAX,
  type ScheduleItem,
  validateCron,
} from "@open-factory/shared";
import { unknownRefError } from "@open-factory/shared/tags";
import { and, eq, or } from "drizzle-orm";
import type { EventStore, Exec } from "../agents/event-store.ts";
import { resolveArg } from "../principals/principal-args.ts";
import { withDeadlockRetry } from "../tasks/task-service.ts";
import { ScheduleError } from "./errors.ts";
import { AGENT_AT_HORIZON_MS, MAX_AGENT_SCHEDULES, MIN_AGENT_GAP_MINUTES } from "./limits.ts";
import {
  type Actor,
  isDone,
  type LockedAgent,
  type LockWant,
  type ScheduleRecord,
  type ScheduleStore,
} from "./schedule-store.ts";

const { schedules } = schema;
const TOOL_BODY_CAP = 2000;

export type { Actor };
export type ScheduleInput = {
  target?: string;
  cron?: string;
  at?: string;
  timezone: string;
  body: string;
};
export type PatchInput = Partial<Omit<ScheduleInput, "timezone">> & { timezone?: string };
export type CreateResult = { item: ScheduleItem; note?: string; warnings?: string[] };
/** What `list_schedules` returns for one schedule (spec §9). */
export type AgentScheduleView = {
  id: string;
  to: string;
  created_by: string;
  by: string;
  cron?: string;
  at?: string;
  timezone: string;
  next_run: string | null;
  paused: boolean;
  yours: boolean;
  body: string;
  truncated?: true;
};

/** A principal as prose or the `by` attribute writes it: `@handle` for a human, the bare handle for an agent. */
const label = (a: ScheduleRecord["createdBy"], at = false) =>
  a.kind === "human" || at ? `@${a.handle}` : a.handle;
const isAgent = (a: Actor) => a.kind === "agent";
const bytes = (s: string) => new TextEncoder().encode(s).length;

const notFound = (name: string) =>
  new ScheduleError(
    "target_not_found",
    `No agent named '${name}'. Call list_peers to see who you can schedule for.`,
    404,
    "target",
  );
const endedSentence = (slug: string, why: "archived" | "terminated") =>
  why === "archived"
    ? `@${slug} is archived and can't receive messages.`
    : `@${slug} was terminated and can't receive messages.`;

export class ScheduleService {
  constructor(
    private readonly d: {
      db: Db;
      store: EventStore;
      schedules: ScheduleStore;
      now: () => Date;
      factoryZone: string;
      /** After a commit: re-arm the timer and publish `schedules_changed`. */
      onChanged: () => void;
      /** The target's runtime status, read outside any transaction (for the `pending_errored` state). */
      statusOf?: (agent: { id: string; status: string }) => string | undefined;
    },
  ) {}

  /**
   * Creates a schedule. Agents are bound by the limits of spec §6.2; humans are not. Input checks come first (no
   * locks), then the transaction takes the agent rows in the global order (§12.1) and checks them live.
   */
  async create(actor: Actor, input: ScheduleInput): Promise<CreateResult> {
    const now = this.d.now();
    const when = this.checkTiming(actor, input, now);
    const body = input.body;
    if (bytes(body) < 1) throw new ScheduleError("invalid_schedule", MSG.messageEmpty, 400, "body");
    if (bytes(body) > SCHEDULE_BODY_MAX)
      throw new ScheduleError("invalid_schedule", MSG.bodyTooLong, 400, "body");
    const target = await this.resolveTarget(actor, input.target);

    const out = await withDeadlockRetry(() =>
      this.d.db.transaction(async (tx) => {
        const wants: LockWant[] = [{ id: target.id, mode: "share" }];
        if (isAgent(actor)) wants.push({ id: actor.id, mode: "update" });
        const locked = await this.d.schedules.lockAgents(tx, wants);
        const byId = new Map(locked.map((a) => [a.id, a]));
        if (isAgent(actor)) {
          const me = byId.get(actor.id);
          if (!me || me.archivedAt || me.terminatedAt)
            throw new ScheduleError(
              "ended",
              "You can't schedule messages: you were terminated.",
              409,
            );
          // Q12: spawned agents have no schedule tools; the service refuses them too (defence in depth).
          if (me.kind === "ephemeral")
            throw new ScheduleError("forbidden", "Spawned agents can't schedule messages.", 403);
        }
        const t = byId.get(target.id);
        if (!t) throw notFound(target.slug);
        this.requireLive(t);
        if (isAgent(actor)) {
          const n = await this.d.schedules.countActiveCreatedBy(tx, actor.id);
          if (n >= MAX_AGENT_SCHEDULES)
            throw new ScheduleError(
              "schedule_limit",
              `You already have ${MAX_AGENT_SCHEDULES} schedules; cancel one first (list_schedules shows them).`,
              409,
            );
        }
        const row = await this.d.schedules.insert(tx, {
          targetAgentId: t.id,
          cron: when.cron,
          runAt: when.runAt,
          timezone: input.timezone,
          body,
          actor,
          nextRunAt: when.nextRunAt,
          now,
        });
        const rec = await this.d.schedules.recordById(tx, row.id);
        return { rec: rec as ScheduleRecord, target: t };
      }),
    );
    this.d.onChanged();
    return {
      item: this.toItem(out.rec),
      ...this.noteFor(actor, out.target, out.rec),
      ...(target.warning ? { warnings: [target.warning] } : {}),
    };
  }

  /** Cron or at: exactly one; valid; in the future; within the agent limits. Returns the stored form. */
  private checkTiming(actor: Actor, input: ScheduleInput, now: Date) {
    const hasCron = input.cron !== undefined;
    const hasAt = input.at !== undefined;
    if (hasCron === hasAt)
      throw new ScheduleError("invalid_schedule", "Pass either cron or at.", 400, "cron");
    if (!isValidZone(input.timezone))
      throw new ScheduleError(
        "invalid_schedule",
        `Unknown time zone '${input.timezone}'; use an IANA name such as Europe/Berlin.`,
        400,
        "timezone",
      );
    if (hasCron) {
      const cron = (input.cron as string).trim();
      const bad = validateCron(cron);
      if (bad) throw new ScheduleError("invalid_schedule", bad, 400, "cron");
      if (isAgent(actor) && minGapMinutes(cron, input.timezone, now, 10) < MIN_AGENT_GAP_MINUTES)
        throw new ScheduleError(
          "invalid_schedule",
          "Schedules can't fire more often than every 15 minutes. For a short loop inside this session, use CronCreate.",
          400,
          "cron",
        );
      const next = nextRun(cron, input.timezone, now);
      if (!next)
        throw new ScheduleError("invalid_schedule", "This pattern never runs.", 400, "cron");
      return { cron, runAt: null, nextRunAt: next };
    }
    const at = parseAt(input.at as string, input.timezone);
    if (!at)
      throw new ScheduleError(
        "invalid_schedule",
        "Use an ISO 8601 date and time, such as 2026-11-23T09:00.",
        400,
        "at",
      );
    if (at.getTime() <= now.getTime())
      throw new ScheduleError("invalid_schedule", "That time has passed.", 400, "at");
    if (isAgent(actor) && at.getTime() - now.getTime() > AGENT_AT_HORIZON_MS)
      throw new ScheduleError("invalid_schedule", "Pick a time within the next year.", 400, "at");
    return { cron: null, runAt: at, nextRunAt: at };
  }

  /** Resolves the target name without locks (§12.1 step 1). An agent's default is itself. */
  private async resolveTarget(
    actor: Actor,
    raw: string | undefined,
  ): Promise<{ id: string; slug: string; warning?: string }> {
    const name = raw?.trim() ?? "";
    if (isAgent(actor) && (name === "" || name === "me")) {
      const me = await this.d.store.agentById(actor.id);
      if (!me)
        throw new ScheduleError("ended", "You can't schedule messages: you were terminated.", 409);
      return { id: me.id, slug: me.slug };
    }
    if (name === "") throw new ScheduleError("invalid_schedule", "Choose an agent.", 400, "target");
    const r = await resolveArg(this.d.db, name);
    if (r.kind === "unknown_ref")
      throw new ScheduleError("target_not_found", unknownRefError(r.ref), 404, "target");
    if (r.kind === "principal") {
      const agent = r.p.kind === "agent" ? await this.d.store.agentById(r.p.id) : undefined;
      if (agent)
        return {
          id: agent.id,
          slug: r.p.handle,
          ...(r.warning ? { warning: r.warning } : {}),
        };
    }
    if (r.kind === "none" || r.kind === "channel") throw notFound(r.name);
    if (r.kind === "reserved")
      throw new ScheduleError(
        "reserved",
        `'${r.name}' is reserved and can't receive messages.`,
        400,
        "target",
      );
    throw new ScheduleError(
      "target_not_agent",
      "Schedules can only be addressed to agents.",
      400,
      "target",
    );
  }

  private requireLive(t: LockedAgent) {
    if (t.terminatedAt)
      throw new ScheduleError("target_ended", endedSentence(t.slug, "terminated"), 409, "target");
    if (t.archivedAt)
      throw new ScheduleError("target_ended", endedSentence(t.slug, "archived"), 409, "target");
  }

  /** A note for an agent's tool result (spec §9). */
  private noteFor(actor: Actor, target: LockedAgent, rec: ScheduleRecord): { note?: string } {
    if (!isAgent(actor)) return {};
    if (this.d.statusOf?.({ id: target.id, status: target.status }) === "errored")
      return {
        note: `@${target.slug} is errored; it will see this after it is restarted (restart_agent, or a human).`,
      };
    if (target.id === actor.id && rec.cron)
      return {
        note: "You will be woken at each run; cancel it with cancel_schedule when it is no longer needed.",
      };
    return {};
  }

  // ---------- reads ----------

  /** One schedule by key; a deleted one only with `includeDeleted` (the edit page's badge link offers Restore). */
  async get(key: string, o: { includeDeleted?: boolean } = {}): Promise<ScheduleItem | undefined> {
    const n = parseKey("S", key);
    if (n === null) return undefined;
    const r = await this.d.schedules.recordByNumber(this.d.db, n);
    if (!r || (r.deletedAt && !o.includeDeleted)) return undefined;
    return this.toItem(r);
  }

  /** Humans' list (spec §11): active by next run, then paused, then done newest first, then key; at most 500. */
  async list(
    f: { target?: string; done?: boolean } = {},
  ): Promise<{ items: ScheduleItem[]; more: boolean }> {
    const rows = await this.d.schedules.records(this.d.db, this.d.schedules.live());
    const rank = (r: ScheduleRecord) => (isDone(r) ? 2 : r.pausedAt ? 1 : 0);
    const at = (r: ScheduleRecord) => r.nextRunAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const doneAt = (r: ScheduleRecord) => (r.lastFiredAt ?? r.runAt)?.getTime() ?? 0;
    const shown = rows
      .filter((r) => (f.target ? r.target.slug === f.target : true))
      .filter((r) => (f.done ? true : !isDone(r)))
      .sort(
        (a, b) =>
          rank(a) - rank(b) ||
          (rank(a) === 2 ? doneAt(b) - doneAt(a) : at(a) - at(b)) ||
          a.number - b.number,
      );
    return { items: shown.slice(0, 500).map((r) => this.toItem(r)), more: shown.length > 500 };
  }

  /** `list_schedules`: what the agent created or what targets it; not deleted, not done; newest first, at most 100. */
  async listForAgent(agentId: string): Promise<AgentScheduleView[]> {
    const rows = await this.d.schedules.records(
      this.d.db,
      and(
        this.d.schedules.live(),
        or(eq(schedules.createdById, agentId), eq(schedules.targetAgentId, agentId)),
      ),
    );
    return rows
      .filter((r) => !isDone(r))
      .sort((a, b) => b.number - a.number)
      .slice(0, 100)
      .map((r) => {
        const chars = Array.from(r.body);
        const long = chars.length > TOOL_BODY_CAP;
        return {
          id: formatKey("S", r.number),
          to: r.target.slug,
          created_by: label(r.createdBy),
          by: label(r.bodyAuthor),
          ...(r.cron ? { cron: r.cron } : {}),
          ...(r.runAt ? { at: formatOffsetIso(r.runAt, r.timezone) } : {}),
          timezone: r.timezone,
          next_run: r.nextRunAt ? formatOffsetIso(r.nextRunAt, r.timezone) : null,
          paused: r.pausedAt !== null,
          yours: r.createdById === agentId,
          body: long ? chars.slice(0, TOOL_BODY_CAP).join("") : r.body,
          ...(long ? { truncated: true as const } : {}),
        };
      });
  }

  /** Unarchive (spec §10.1): every schedule targeting the agent recomputes from now, in the caller's transaction. */
  async recomputeForTarget(tx: Exec, agentId: string): Promise<void> {
    for (const id of await this.d.schedules.idsTargeting(tx, agentId))
      await this.recomputeFromNow(tx, id);
  }

  /** After a commit made elsewhere (unarchive): re-arm the timer and tell the pages. */
  changed(): void {
    this.d.onChanged();
  }

  async scheduleCountFor(agentId: string): Promise<number> {
    return this.d.schedules.countFor(this.d.db, agentId);
  }

  // ---------- changes ----------

  /** The one helper behind resume, restore, unarchive and timing edits: "no catch-up" lives here (spec §6.3). */
  async recomputeFromNow(tx: Exec, id: string): Promise<void> {
    const [row] = await tx.select().from(schedules).where(eq(schedules.id, id));
    if (!row) return;
    const now = this.d.now();
    const next = row.cron
      ? nextRun(row.cron, row.timezone, now)
      : row.runAt && row.runAt.getTime() > now.getTime()
        ? row.runAt
        : null;
    await this.d.schedules.update(tx, id, {
      nextRunAt: next,
      failCount: 0,
      retryAt: null,
      updatedAt: now,
    });
  }

  /**
   * Human edit (spec §6.3, Q18): only the fields present are validated and changed. Timing changes recompute
   * `next_run_at` from now; a body change makes the editor the author; a pending firing is never touched.
   */
  async edit(actor: Actor, key: string, patch: PatchInput): Promise<ScheduleItem> {
    const n = this.keyOrThrow(key);
    const now = this.d.now();
    if (patch.cron !== undefined && patch.at !== undefined)
      throw new ScheduleError("invalid_schedule", "Pass either cron or at.", 400, "cron");
    if (patch.body !== undefined) this.checkBody(patch.body);
    if (patch.timezone !== undefined && !isValidZone(patch.timezone))
      throw new ScheduleError(
        "invalid_schedule",
        `Unknown time zone '${patch.timezone}'; use an IANA name such as Europe/Berlin.`,
        400,
        "timezone",
      );
    const target =
      patch.target !== undefined ? await this.resolveTarget(actor, patch.target) : undefined;
    const rec = await withDeadlockRetry(() =>
      this.d.db.transaction(async (tx) => {
        if (target) {
          const locked = await this.d.schedules.lockAgents(tx, [{ id: target.id, mode: "share" }]);
          const t = locked[0];
          if (!t) throw notFound(target.slug);
          this.requireLive(t);
        }
        const row = await this.d.schedules.lockByNumber(tx, n);
        if (!row || row.deletedAt) throw this.gone();
        const set: Partial<ScheduleRow> = { updatedAt: now };
        if (target) set.targetAgentId = target.id;
        if (patch.body !== undefined && patch.body !== row.body) {
          set.body = patch.body;
          set.bodyAuthorId = actor.id;
        } else if (patch.body !== undefined) {
          // Unchanged text: the editor is not its author.
        }
        if (
          patch.timezone !== undefined &&
          patch.cron === undefined &&
          patch.at === undefined &&
          !row.cron &&
          patch.timezone !== row.timezone
        )
          throw new ScheduleError(
            "invalid_schedule",
            "Change the time as well when you change a one-time schedule's time zone.",
            400,
            "timezone",
          );
        const timing =
          patch.cron !== undefined || patch.at !== undefined || patch.timezone !== undefined;
        if (timing) {
          const zone = patch.timezone ?? row.timezone;
          set.timezone = zone;
          if (patch.cron !== undefined || (patch.at === undefined && row.cron)) {
            const cron = (patch.cron ?? row.cron) as string;
            if (patch.cron !== undefined) {
              const bad = validateCron(cron);
              if (bad) throw new ScheduleError("invalid_schedule", bad, 400, "cron");
            }
            const next = nextRun(cron, zone, now);
            if (!next)
              throw new ScheduleError("invalid_schedule", "This pattern never runs.", 400, "cron");
            set.cron = cron.trim();
            set.runAt = null;
            set.nextRunAt = next;
          } else {
            let runAt = row.runAt;
            if (patch.at !== undefined) {
              runAt = parseAt(patch.at, zone);
              if (!runAt)
                throw new ScheduleError(
                  "invalid_schedule",
                  "Use an ISO 8601 date and time, such as 2026-11-23T09:00.",
                  400,
                  "at",
                );
              if (runAt.getTime() <= now.getTime())
                throw new ScheduleError("invalid_schedule", "That time has passed.", 400, "at");
            }
            set.cron = null;
            set.runAt = runAt;
            set.nextRunAt = runAt && runAt.getTime() > now.getTime() ? runAt : null;
          }
        }
        // Every human edit clears the firing backoff (body and target included).
        set.failCount = 0;
        set.retryAt = null;
        await this.d.schedules.update(tx, row.id, set);
        return (await this.d.schedules.recordById(tx, row.id)) as ScheduleRecord;
      }),
    );
    this.d.onChanged();
    return this.toItem(rec);
  }

  async pause(_actor: Actor, key: string): Promise<ScheduleItem> {
    return this.mutate(key, (row, now) => {
      if (isDone(row))
        throw new ScheduleError(
          "schedule_done",
          `${formatKey("S", row.number)} is done; it has nothing left to pause.`,
          409,
        );
      if (row.pausedAt)
        throw new ScheduleError(
          "already_paused",
          `${formatKey("S", row.number)} is already paused.`,
          409,
        );
      return { pausedAt: now, updatedAt: now };
    });
  }

  async resume(_actor: Actor, key: string): Promise<ScheduleItem> {
    return this.mutate(
      key,
      (row, now) => {
        if (isDone(row))
          throw new ScheduleError(
            "schedule_done",
            `${formatKey("S", row.number)} is done; it has nothing left to resume.`,
            409,
          );
        if (!row.pausedAt)
          throw new ScheduleError("not_paused", `${formatKey("S", row.number)} isn't paused.`, 409);
        return { pausedAt: null, updatedAt: now };
      },
      true,
    );
  }

  /** Soft delete (Q17): `deleted_at` set, `next_run_at` null. Agents reach it through `cancelForAgent`. */
  async remove(_actor: Actor, key: string): Promise<ScheduleItem> {
    return this.mutate(key, (_row, now) => ({ deletedAt: now, nextRunAt: null, updatedAt: now }));
  }

  /** Undo of a delete: humans only; refused when the target ended (R2); recomputes from now. */
  async restore(_actor: Actor, key: string): Promise<ScheduleItem> {
    const n = this.keyOrThrow(key);
    const probe = await this.d.schedules.recordByNumber(this.d.db, n);
    if (!probe) throw this.gone();
    const rec = await withDeadlockRetry(() =>
      this.d.db.transaction(async (tx) => {
        // Agents first (§12.1): the target FOR SHARE, and an agent creator FOR NO KEY UPDATE so the limit can't be raced.
        const wants: LockWant[] = [{ id: probe.targetAgentId, mode: "share" }];
        if (probe.createdBy.kind === "agent") wants.push({ id: probe.createdById, mode: "update" });
        const locked = await this.d.schedules.lockAgents(tx, wants);
        const t = locked.find((a) => a.id === probe.targetAgentId);
        if (t?.terminatedAt)
          throw new ScheduleError("target_ended", `@${t.slug} was terminated.`, 409);
        if (t?.archivedAt) throw new ScheduleError("target_ended", `@${t.slug} is archived.`, 409);
        const row = await this.d.schedules.lockByNumber(tx, n);
        if (!row) throw this.gone();
        if (row.deletedAt) {
          // A restore counts like a create toward an agent creator's 20 (delete + restore must not bypass it); a
          // one-shot that restores as done doesn't count.
          const asDone = row.runAt !== null && row.runAt.getTime() <= this.d.now().getTime();
          const creator = locked.find((a) => a.id === row.createdById);
          if (
            creator &&
            !asDone &&
            (await this.d.schedules.countActiveCreatedBy(tx, creator.id)) >= MAX_AGENT_SCHEDULES
          )
            throw new ScheduleError(
              "schedule_limit",
              `@${creator.slug} already has ${MAX_AGENT_SCHEDULES} schedules; delete one first.`,
              409,
            );
          await this.d.schedules.update(tx, row.id, { deletedAt: null, updatedAt: this.d.now() });
          await this.recomputeFromNow(tx, row.id);
        }
        return (await this.d.schedules.recordById(tx, row.id)) as ScheduleRecord;
      }),
    );
    this.d.onChanged();
    return this.toItem(rec);
  }

  /** `cancel_schedule`: only what the caller created (spec §9); a pending firing is still delivered. */
  async cancelForAgent(agentId: string, key: string): Promise<{ id: string; status: "cancelled" }> {
    const n = parseKey("S", key);
    const rec = n === null ? undefined : await this.d.schedules.recordByNumber(this.d.db, n);
    const id = n === null ? key : formatKey("S", n);
    if (!rec || rec.deletedAt)
      throw new ScheduleError("schedule_not_found", `There is no schedule ${id}.`, 404);
    if (rec.createdById !== agentId)
      throw new ScheduleError(
        "forbidden",
        `${id} was created by ${label(rec.createdBy, true)}; only its creator or a human can cancel it.`,
        403,
      );
    await this.mutate(key, (row, now) => {
      if (row.createdById !== agentId)
        throw new ScheduleError(
          "forbidden",
          `${id} was created by someone else; only its creator or a human can cancel it.`,
          403,
        );
      return { deletedAt: now, nextRunAt: null, updatedAt: now };
    });
    return { id, status: "cancelled" };
  }

  /** Locks the schedule, applies `fn`'s change, optionally recomputes from now, commits, publishes. */
  private async mutate(
    key: string,
    fn: (row: ScheduleRow, now: Date) => Partial<ScheduleRow>,
    recompute = false,
  ): Promise<ScheduleItem> {
    const n = this.keyOrThrow(key);
    const rec = await withDeadlockRetry(() =>
      this.d.db.transaction(async (tx) => {
        const row = await this.d.schedules.lockByNumber(tx, n);
        if (!row || row.deletedAt) throw this.gone();
        const set = fn(row, this.d.now());
        await this.d.schedules.update(tx, row.id, set);
        if (recompute) await this.recomputeFromNow(tx, row.id);
        return (await this.d.schedules.recordById(tx, row.id)) as ScheduleRecord;
      }),
    );
    this.d.onChanged();
    return this.toItem(rec);
  }

  private keyOrThrow(key: string): number {
    const n = parseKey("S", key);
    if (n === null) throw this.gone();
    return n;
  }
  private gone() {
    return new ScheduleError("schedule_not_found", "There is no such schedule.", 404);
  }
  private checkBody(body: string) {
    if (bytes(body) < 1) throw new ScheduleError("invalid_schedule", MSG.messageEmpty, 400, "body");
    if (bytes(body) > SCHEDULE_BODY_MAX)
      throw new ScheduleError("invalid_schedule", MSG.bodyTooLong, 400, "body");
  }

  /** The item the API returns: derived state, names, no status column (Q15). */
  toItem(r: ScheduleRecord): ScheduleItem {
    const done = isDone(r);
    const paused = r.pausedAt !== null;
    const targetErrored =
      this.d.statusOf?.({ id: r.targetAgentId, status: r.target.status }) === "errored";
    const state: ScheduleItem["state"] = done
      ? "done"
      : paused
        ? "paused"
        : r.target.archivedAt
          ? "skipped_archived"
          : r.pendingFiring && targetErrored
            ? "pending_errored"
            : "active";
    const author = (a: ScheduleRecord["createdBy"]) =>
      a.kind === "agent"
        ? {
            kind: "agent" as const,
            ref: a.ref,
            handle: a.handle,
            archived: a.archivedAt !== null,
            terminated: a.terminatedAt !== null,
          }
        : { kind: "human" as const, ref: a.ref, handle: a.handle };
    return {
      key: formatKey("S", r.number),
      target: {
        slug: r.target.slug,
        displayName: r.target.displayName,
        archived: r.target.archivedAt !== null,
        terminated: r.target.terminatedAt !== null,
      },
      ...(r.cron ? { cron: r.cron } : {}),
      ...(r.runAt ? { at: r.runAt.toISOString() } : {}),
      timezone: r.timezone,
      body: r.body,
      nextRunAt: r.nextRunAt?.toISOString() ?? null,
      lastFiredAt: r.lastFiredAt?.toISOString() ?? null,
      paused,
      done,
      ...(done ? { ran: r.lastFiredAt !== null } : {}),
      ...(r.deletedAt ? { deleted: true } : {}),
      createdBy: author(r.createdBy),
      bodyAuthor: author(r.bodyAuthor),
      pendingFiring: r.pendingFiring,
      state,
    };
  }
}
