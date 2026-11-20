import type { Db } from "@open-factory/db";
import {
  formatKey,
  isValidZone,
  minGapMinutes,
  nextRun,
  parseAt,
  type ScheduleItem,
  validateCron,
} from "@open-factory/shared";
import type { EventStore } from "../agents/event-store.ts";
import { resolveName } from "../messaging/principals.ts";
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

const BODY_MAX = 64 * 1024;

export type { Actor };
export type ScheduleInput = {
  target?: string;
  cron?: string;
  at?: string;
  timezone: string;
  body: string;
};
export type CreateResult = { item: ScheduleItem; note?: string };

const isAgent = (a: Actor): a is { agentId: string } => "agentId" in a;
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
      statusOf?: (agentId: string) => string | undefined;
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
    if (bytes(body) < 1)
      throw new ScheduleError("invalid_schedule", "The message can't be empty.", 400, "body");
    if (bytes(body) > BODY_MAX)
      throw new ScheduleError(
        "invalid_schedule",
        "The message is too long (64 KB at most).",
        400,
        "body",
      );
    const target = await this.resolveTarget(actor, input.target);

    const out = await withDeadlockRetry(() =>
      this.d.db.transaction(async (tx) => {
        const wants: LockWant[] = [{ id: target.id, mode: "share" }];
        if (isAgent(actor)) wants.push({ id: actor.agentId, mode: "update" });
        const locked = await this.d.schedules.lockAgents(tx, wants);
        const byId = new Map(locked.map((a) => [a.id, a]));
        if (isAgent(actor)) {
          const me = byId.get(actor.agentId);
          if (!me || me.archivedAt || me.terminatedAt)
            throw new ScheduleError(
              "ended",
              "You can't schedule messages: you were terminated.",
              409,
            );
        }
        const t = byId.get(target.id);
        if (!t) throw notFound(target.slug);
        this.requireLive(t);
        if (isAgent(actor)) {
          const n = await this.d.schedules.countActiveCreatedBy(tx, actor.agentId);
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
    return { item: this.toItem(out.rec), ...this.noteFor(actor, out.target, out.rec) };
  }

  /** Cron or at: exactly one; valid; in the future; within the agent limits. Returns the stored form. */
  private checkTiming(actor: Actor, input: ScheduleInput, now: Date) {
    const hasCron = input.cron !== undefined && input.cron !== "";
    const hasAt = input.at !== undefined && input.at !== "";
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
  private async resolveTarget(actor: Actor, raw: string | undefined) {
    const name = raw?.trim() ?? "";
    if (isAgent(actor) && (name === "" || name === "me")) {
      const me = await this.d.store.agentById(actor.agentId);
      if (!me)
        throw new ScheduleError("ended", "You can't schedule messages: you were terminated.", 409);
      return { id: me.id, slug: me.slug };
    }
    if (name === "") throw new ScheduleError("invalid_schedule", "Choose an agent.", 400, "target");
    const r = await resolveName(this.d.db, name);
    switch (r.kind) {
      case "agent":
        return { id: r.agent.id, slug: r.agent.slug };
      case "none":
        throw notFound(r.name);
      case "ambiguous":
        throw new ScheduleError(
          "ambiguous",
          `'${r.name}' matches both an agent and a user; ask a human to rename one.`,
          400,
          "target",
        );
      case "reserved":
        throw new ScheduleError(
          "reserved",
          `'${r.name}' is reserved and can't receive messages.`,
          400,
          "target",
        );
      default:
        throw new ScheduleError(
          "target_not_agent",
          "Schedules can only be addressed to agents.",
          400,
          "target",
        );
    }
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
    if (this.d.statusOf?.(target.id) === "errored")
      return { note: `@${target.slug} is errored; it will see this when a human restarts it.` };
    if (target.id === actor.agentId && rec.cron)
      return {
        note: "You will be woken at each run; cancel it with cancel_schedule when it is no longer needed.",
      };
    return {};
  }

  /** The item the API returns: derived state, names, no status column (Q15). */
  toItem(r: ScheduleRecord): ScheduleItem {
    const done = isDone(r);
    const paused = r.pausedAt !== null;
    const targetErrored = this.d.statusOf?.(r.targetAgentId) === "errored";
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
            slug: a.slug,
            archived: a.archivedAt !== null,
            terminated: a.terminatedAt !== null,
          }
        : { kind: "user" as const, handle: a.handle };
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
