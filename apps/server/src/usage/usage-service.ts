/**
 * Usage rollups over `turns` (S10 spec §6, §7). Each method is ONE SQL statement with `now` and the factory timezone
 * passed as parameters (never Postgres `now()`), and nothing is cached. A turn counts when it has `ended_at`, by
 * `started_at`; NULL cost and tokens count as 0.
 *
 * - Calendar window: the last `days` local days including today,
 *   `started_at >= ((($now AT TIME ZONE $tz)::date - (days-1))::timestamp AT TIME ZONE $tz)` and before local midnight
 *   tonight, so a turn stamped later (clock skew) is in no total and no bar: totals always equal the bars (F4).
 * - Rolling window (the tree): `started_at >= $now - interval '7 days'`.
 * - Spawner scope of a persistent agent X: X plus every agent with `kind = 'ephemeral' AND reports_to = X` (one level,
 *   S7), terminated ones included; never the reporting line.
 */
import type { Db } from "@open-factory/db";
import type {
  AgentsUsage,
  AgentUsage,
  AgentUsageRow,
  CredentialsUsage,
  DailyUsage,
  DayUsage,
  Totals,
  UsageDays,
} from "@open-factory/shared";
import { type SQL, sql } from "drizzle-orm";
import { toRateLimitState } from "../credentials/rate-limit-state.ts";

export type UsageWindow = { kind: "rolling"; days: 7 } | { kind: "calendar"; days: UsageDays };
type Params = { now: string; tz: string };
type Raw = Record<string, unknown>;

/** The six totals as aliased aggregates over `turns` rows (or a CTE of them). */
const SUMS = sql`coalesce(sum(coalesce(cost_usd, 0)), 0) as "costUsd",
  coalesce(sum(coalesce(input_tokens, 0)), 0) as "inputTokens",
  coalesce(sum(coalesce(output_tokens, 0)), 0) as "outputTokens",
  coalesce(sum(coalesce(cache_write_tokens, 0)), 0) as "cacheWriteTokens",
  coalesce(sum(coalesce(cache_read_tokens, 0)), 0) as "cacheReadTokens",
  count(*) as "turns"`;

/** Re-sums rows that already carry the `SUMS` columns. */
const RESUM = sql`coalesce(sum("costUsd"), 0) as "costUsd",
  coalesce(sum("inputTokens"), 0) as "inputTokens",
  coalesce(sum("outputTokens"), 0) as "outputTokens",
  coalesce(sum("cacheWriteTokens"), 0) as "cacheWriteTokens",
  coalesce(sum("cacheReadTokens"), 0) as "cacheReadTokens",
  coalesce(sum("turns"), 0) as "turns"`;

const FIELDS = [
  "costUsd",
  "inputTokens",
  "outputTokens",
  "cacheWriteTokens",
  "cacheReadTokens",
  "turns",
] as const;

/** The `SUMS` columns renamed with a prefix (`own` → `ownCostUsd`, …). */
const prefixed = (p: string) =>
  sql.raw(FIELDS.map((f) => `"${f}" as "${p}${f[0]?.toUpperCase()}${f.slice(1)}"`).join(", "));

/** A timestamptz as `toISOString()` writes it. */
const iso = (col: string) =>
  sql.raw(`to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);

/** `a, b, c` as bound parameters (drizzle expands a JS array into a tuple, not a Postgres array). */
const list = (xs: string[]) =>
  sql.join(
    xs.map((x) => sql`${x}`),
    sql`, `,
  );

/** Numerics and bigints arrive as strings (or JSON numbers): every field goes through `Number()`. */
function totals(r: Raw | null | undefined, prefix = ""): Totals {
  const f = (k: (typeof FIELDS)[number]) =>
    Number(r?.[prefix ? `${prefix}${k[0]?.toUpperCase()}${k.slice(1)}` : k] ?? 0);
  return {
    costUsd: f("costUsd"),
    inputTokens: f("inputTokens"),
    outputTokens: f("outputTokens"),
    cacheWriteTokens: f("cacheWriteTokens"),
    cacheReadTokens: f("cacheReadTokens"),
    turns: f("turns"),
  };
}

const day = (r: Raw): DayUsage => ({ date: String(r.date), ...totals(r) });

/** Adds two totals; cost in whole micro-dollars (`numeric(12,6)`) so the sum matches Postgres's. */
function add(a: Totals, b: Totals): Totals {
  return {
    costUsd: (Math.round(a.costUsd * 1e6) + Math.round(b.costUsd * 1e6)) / 1e6,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    turns: a.turns + b.turns,
  };
}

const arr = (v: unknown) => (v as Raw[] | null) ?? [];

export class UsageService {
  constructor(private readonly d: { db: Db; now: () => Date; timezone: () => string }) {}

  private params(): Params {
    return { now: this.d.now().toISOString(), tz: this.d.timezone() };
  }

  /** An ISO timestamp column from a raw row, as a Date. */
  private static date(v: unknown): Date | null {
    return v == null ? null : new Date(String(v));
  }

  private async rows(q: SQL): Promise<Raw[]> {
    return (await this.d.db.execute(q)) as unknown as Raw[];
  }

  /** Today's local date. */
  private today(p: Params) {
    return sql`((${p.now}::timestamptz at time zone ${p.tz}::text)::date)`;
  }

  /** The first instant of a window. */
  private start(p: Params, w: UsageWindow) {
    if (w.kind === "rolling") return sql`(${p.now}::timestamptz - interval '7 days')`;
    return sql`((${this.today(p)} - ${w.days - 1}::int)::timestamp at time zone ${p.tz}::text)`;
  }

  /** The predicate of the turns a window counts; a calendar window ends at local midnight tonight. */
  private counted(p: Params, w: UsageWindow) {
    const end =
      w.kind === "calendar"
        ? sql` and started_at < ((${this.today(p)} + 1)::timestamp at time zone ${p.tz}::text)`
        : sql``;
    return sql`ended_at is not null and started_at >= ${this.start(p, w)}${end}`;
  }

  /** One row per local day from the window's first day to today (zero-filled), over the turns in CTE `t`. */
  private dailySeries(p: Params, days: UsageDays) {
    return sql`select to_char(s.d, 'YYYY-MM-DD') as "date",
        coalesce(b."costUsd", 0) as "costUsd", coalesce(b."inputTokens", 0) as "inputTokens",
        coalesce(b."outputTokens", 0) as "outputTokens", coalesce(b."cacheWriteTokens", 0) as "cacheWriteTokens",
        coalesce(b."cacheReadTokens", 0) as "cacheReadTokens", coalesce(b."turns", 0) as "turns"
      from (select generate_series((${this.today(p)} - ${days - 1}::int)::timestamp, ${this.today(p)}::timestamp,
                                   interval '1 day')::date as d) s
      left join (select (started_at at time zone ${p.tz}::text)::date as d, ${SUMS} from t group by 1) b
        on b.d = s.d
      order by s.d`;
  }

  async daily(days: UsageDays, scope?: { agentIds: string[] }): Promise<DailyUsage> {
    const p = this.params();
    const inScope = !scope
      ? sql``
      : scope.agentIds.length
        ? sql`and agent_id in (${list(scope.agentIds)})`
        : sql`and false`;
    const r = await this.rows(
      sql`with t as (select * from turns where ${this.counted(p, { kind: "calendar", days })} ${inScope})
          ${this.dailySeries(p, days)}`,
    );
    return { timezone: p.tz, days: r.map(day) };
  }

  /** Every agent with turns in the window (own or spawned) plus every live persistent agent, by total cost. */
  async agents(window: UsageWindow): Promise<AgentsUsage> {
    const p = this.params();
    const r = await this.rows(
      sql`with w as (select agent_id, ${SUMS} from turns where ${this.counted(p, window)} group by agent_id)
        select a.slug, a.display_name, a.kind, sp.slug as spawner_slug,
               a.archived_at is not null as archived, a.terminated_at is not null as terminated,
               ${prefixed("own")}, s.*
        from agents a
        left join agents sp on a.kind = 'ephemeral' and sp.id = a.reports_to
        left join w on w.agent_id = a.id
        left join lateral (
          select ${prefixed("spawned")} from (
            select ${RESUM} from w join agents c on c.id = w.agent_id
            where a.kind = 'persistent' and c.kind = 'ephemeral' and c.reports_to = a.id) q
        ) s on true
        where w.agent_id is not null or s."spawnedTurns" > 0 or (a.kind = 'persistent' and a.archived_at is null)
        order by coalesce(w."costUsd", 0) + s."spawnedCostUsd" desc, a.slug`,
    );
    return {
      agents: r.map((a): AgentUsageRow => {
        const own = totals(a, "own");
        const spawned = a.kind === "persistent" ? totals(a, "spawned") : undefined;
        return {
          slug: String(a.slug),
          displayName: String(a.display_name),
          kind: spawned ? "persistent" : "ephemeral",
          ...(a.spawner_slug ? { spawnerSlug: String(a.spawner_slug) } : {}),
          archived: Boolean(a.archived),
          terminated: Boolean(a.terminated),
          own,
          ...(spawned ? { spawned } : {}),
          total: spawned ? add(own, spawned) : own,
        };
      }),
    };
  }

  /** Every credential by name (top 5 agents by cost, rate-limit state, a live pause) and the NULL-credential turns. */
  async credentials(days: UsageDays): Promise<CredentialsUsage> {
    const p = this.params();
    // One row per credential plus a final row with a NULL id: the unattributed turns.
    const r = await this.rows(
      sql`with w as (select credential_id, agent_id, ${SUMS} from turns
                     where ${this.counted(p, { kind: "calendar", days })} group by credential_id, agent_id),
        cr as (
          select id, name, kind, rl_status, rl_type, rl_utilization, ${iso("rl_resets_at")} as rl_resets_at,
                 ${iso("rl_observed_at")} as rl_observed_at, ${iso("rate_limited_until")} as rate_limited_until,
                 rate_limit_exact, false as unattributed
          from credentials
          union all
          select null, null, null, null, null, null, null, null, null, null, true
        )
        select cr.*, tot.*, top.agents
        from cr
        left join lateral (select ${RESUM} from w where w.credential_id is not distinct from cr.id) tot on true
        left join lateral (
          select coalesce(json_agg(json_build_object('slug', q.slug, 'costUsd', q.cost)
                                   order by q.cost desc, q.slug), '[]'::json) as agents
          from (select a.slug, w."costUsd" as cost from w join agents a on a.id = w.agent_id
                where w.credential_id = cr.id
                order by w."costUsd" desc, a.slug limit 5) q
        ) top on true
        order by cr.unattributed, cr.name`,
    );
    const unattributed = r.find((c) => c.unattributed === true);
    return {
      credentials: r
        .filter((c) => c !== unattributed)
        .map((c) => ({
          name: String(c.name),
          kind: c.kind === "api_key" ? "api_key" : "oauth_token",
          totals: totals(c),
          agents: arr(c.agents).map((a) => ({ slug: String(a.slug), costUsd: Number(a.costUsd) })),
          ...toRateLimitState(
            {
              rlStatus: (c.rl_status ?? null) as "allowed" | "allowed_warning" | "rejected" | null,
              rlType: c.rl_type == null ? null : String(c.rl_type),
              rlUtilization: c.rl_utilization == null ? null : Number(c.rl_utilization),
              rlResetsAt: UsageService.date(c.rl_resets_at),
              rlObservedAt: UsageService.date(c.rl_observed_at),
              rateLimitedUntil: UsageService.date(c.rate_limited_until),
              rateLimitExact: Boolean(c.rate_limit_exact),
            },
            new Date(p.now),
          ),
        })),
      unattributed: totals(unattributed),
    };
  }

  /** One agent's page: spawner scope for a persistent agent, its own turns for a spawned one. */
  async agent(slug: string, days: UsageDays): Promise<AgentUsage | undefined> {
    const p = this.params();
    const totalsJson = (from: SQL) =>
      sql`(select row_to_json(z) from (select ${SUMS} from ${from}) z)`;
    const [r] = await this.rows(
      sql`with a as (select id, slug, display_name, kind from agents where slug = ${slug}),
        scope as (
          select id from a
          union all
          select c.id from agents c join a on a.kind = 'persistent' and c.kind = 'ephemeral' and c.reports_to = a.id
        ),
        t as (select * from turns
              where agent_id in (select id from scope) and ${this.counted(p, { kind: "calendar", days })})
        select a.slug, a.display_name, a.kind,
          ${totalsJson(sql`t`)} as total,
          ${totalsJson(sql`t where t.agent_id = (select id from a)`)} as own,
          (select coalesce(json_agg(row_to_json(dd)), '[]'::json) from (${this.dailySeries(p, days)}) dd) as daily,
          (select coalesce(json_agg(row_to_json(m) order by m."costUsd" desc, m.model), '[]'::json) from (
             select model, ${SUMS} from t group by 1) m) as by_model,
          (select coalesce(json_agg(row_to_json(k) order by k."costUsd" desc, k.number), '[]'::json) from (
             select 'T-' || tk.number as key, tk.title, tk.number, ${SUMS}
             from t join tasks tk on tk.id = t.task_id
             group by tk.id, tk.number, tk.title
             order by "costUsd" desc, tk.number limit 20) k) as by_task,
          (select coalesce(json_agg(row_to_json(c) order by c."costUsd" desc, c.slug), '[]'::json) from (
             select ag.slug, ag.display_name as "displayName", ag.terminated_at is not null as terminated, ${SUMS}
             from t join agents ag on ag.id = t.agent_id
             where ag.id <> (select id from a)
             group by ag.id, ag.slug, ag.display_name, ag.terminated_at) c) as spawned
        from a`,
    );
    if (!r) return undefined;
    return {
      agent: {
        slug: String(r.slug),
        displayName: String(r.display_name),
        kind: r.kind === "ephemeral" ? "ephemeral" : "persistent",
      },
      timezone: p.tz,
      total: totals(r.total as Raw),
      own: totals(r.own as Raw),
      daily: arr(r.daily).map(day),
      // A turn without a model stays null: the UI owns its label.
      byModel: arr(r.by_model).map((m) => ({
        model: m.model == null ? null : String(m.model),
        ...totals(m),
      })),
      byTask: arr(r.by_task).map((k) => ({
        key: String(k.key),
        title: String(k.title),
        ...totals(k),
      })),
      spawned: arr(r.spawned).map((c) => ({
        slug: String(c.slug),
        displayName: String(c.displayName),
        terminated: Boolean(c.terminated),
        ...totals(c),
      })),
    };
  }

  /** Every closed turn attributed to the task, in any window; null when there is none. */
  async task(taskId: string): Promise<{ costUsd: number; turns: number } | null> {
    const [r] = await this.rows(
      sql`select ${SUMS} from turns where task_id = ${taskId} and ended_at is not null`,
    );
    const t = totals(r);
    return t.turns ? { costUsd: t.costUsd, turns: t.turns } : null;
  }
}
