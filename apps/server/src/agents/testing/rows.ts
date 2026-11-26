import type postgres from "postgres";
import { principalSql, testManagerUserIdSql } from "../../test/principals.ts";

/** A minimal agent row (plus a credential row with a dummy blob) for tests that don't start real agents. */
export async function insertAgent(
  sql: postgres.Sql,
  a: {
    id: string;
    slug: string;
    sessionId?: string | null;
    status?: string;
    /** Pins the warm window in the overlay (I2: `agents.config` is the overlay); omitted by default. */
    warmWindowMinutes?: number;
    displayName?: string;
    /** The manager's principal id: the spawner of an ephemeral agent; the oldest user when omitted. */
    reportsTo?: string;
    archived?: boolean;
    archivedAt?: Date | string | null;
    errorKind?: string | null;
    /** A terminated agent is ephemeral (a DB check): it needs a `reportsTo`. */
    terminatedAt?: Date | string | null;
    /** Defaults to ephemeral when terminated, else persistent. An ephemeral agent needs a `reportsTo`. */
    kind?: "persistent" | "ephemeral";
  },
): Promise<void> {
  const credId = `cred-${a.id}`;
  await sql`insert into credentials (id, name, kind, value_enc)
            values (${credId}, ${`cred-${a.id}`}, 'oauth_token', ${Buffer.from("dummy")})`;
  await sql.unsafe(principalSql(a.id, "agent", a.slug));
  const kind = a.kind ?? (a.terminatedAt ? "ephemeral" : "persistent");
  const reportsTo = a.reportsTo ?? (await testManagerUserIdSql(sql));
  await sql`insert into agents (id, slug, display_name, session_id, status, template, config, runtime, credential_id, reports_to, archived_at, error_kind, kind, terminated_at, terminated_by)
            values (${a.id}, ${a.slug}, ${a.displayName ?? "Dev agent"}, ${a.sessionId ?? null}, ${a.status ?? "hibernated"},
                    'test', ${JSON.stringify(a.warmWindowMinutes !== undefined ? { template: { warm_window_minutes: a.warmWindowMinutes } } : {})}::jsonb, 'local', ${credId},
                    ${reportsTo}, ${a.archivedAt ? new Date(a.archivedAt).toISOString() : a.archived ? new Date().toISOString() : null}, ${a.errorKind ?? null}, ${kind}, ${a.terminatedAt ? new Date(a.terminatedAt).toISOString() : null}, null)`;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** A turn row with its usage. `endedAt` defaults to a minute after the start (`null` leaves the turn open); usage defaults to NULL. */
export async function insertTurn(
  sql: postgres.Sql,
  t: {
    id: string;
    agentId: string;
    startedAt: Date;
    endedAt?: Date | null;
    costUsd?: number | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    cacheWriteTokens?: number | null;
    cacheReadTokens?: number | null;
    model?: string | null;
    taskId?: string | null;
    credentialId?: string | null;
  },
): Promise<void> {
  const ended = t.endedAt === undefined ? new Date(t.startedAt.getTime() + 60_000) : t.endedAt;
  await sql`insert into turns (id, agent_id, started_at, ended_at, cost_usd, input_tokens, output_tokens, cache_write_tokens,
                               cache_read_tokens, model, task_id, credential_id)
            values (${t.id}, ${t.agentId}, ${iso(t.startedAt)}, ${iso(ended)},
                    ${t.costUsd == null ? null : t.costUsd.toFixed(6)}, ${t.inputTokens ?? null}, ${t.outputTokens ?? null},
                    ${t.cacheWriteTokens ?? null}, ${t.cacheReadTokens ?? null}, ${t.model ?? null}, ${t.taskId ?? null},
                    ${t.credentialId ?? null})`;
}

/** A schedule row (number from the sequence) for tests that don't go through the service. The creator and author are principal `u1` unless given. */
export async function insertSchedule(
  sql: postgres.Sql,
  s: {
    id: string;
    targetAgentId: string;
    cron?: string;
    runAt?: Date;
    timezone?: string;
    body?: string;
    createdById?: string;
    nextRunAt?: Date | null;
    pausedAt?: Date | null;
    deletedAt?: Date | null;
  },
): Promise<void> {
  const by = s.createdById ?? "u1";
  await sql`insert into schedules (id, target_agent_id, cron, run_at, timezone, body, created_by_id, body_author_id,
                                   next_run_at, paused_at, deleted_at)
            values (${s.id}, ${s.targetAgentId}, ${s.cron ?? (s.runAt ? null : "0 9 * * *")}, ${iso(s.runAt)},
                    ${s.timezone ?? "UTC"}, ${s.body ?? "Review"}, ${by}, ${by},
                    ${iso(s.nextRunAt)}, ${iso(s.pausedAt)}, ${iso(s.deletedAt)})`;
}

/** A pending `scheduled` message row, as the scheduler writes it. */
export async function insertScheduledMessage(
  sql: postgres.Sql,
  m: {
    id: string;
    toAgentId: string;
    scheduleId: string;
    body?: string;
    authorId?: string;
    dueAt?: Date;
    firings?: number;
    late?: boolean;
    state?: string;
    createdAt?: Date;
  },
): Promise<void> {
  await sql`insert into messages (id, kind, to_id, schedule_id, author_id, due_at, firings, late, body, state, created_at)
            values (${m.id}, 'scheduled', ${m.toAgentId}, ${m.scheduleId}, ${m.authorId ?? "u1"},
                    ${iso(m.dueAt ?? new Date("2026-11-23T08:00:00Z"))}, ${m.firings ?? 1}, ${m.late ?? false},
                    ${m.body ?? "Review"}, ${m.state ?? "pending"}, ${iso(m.createdAt ?? new Date())})`;
}
