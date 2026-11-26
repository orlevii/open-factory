import type { Totals, UsageDays } from "@open-factory/shared";
import { afterAll, beforeAll, expect, test } from "vitest";
import { insertAgent, insertTurn } from "../agents/testing/rows.ts";
import { createTestDb } from "../test/helpers.ts";
import { principalSql, refOfHandle, testRef, UNKNOWN_REF } from "../test/principals.ts";
import { UsageService } from "./usage-service.ts";

/** S10 AC1: every rollup equals a reference sum computed here from the seeded turns (spec §6, §7). */
const TZ = "America/New_York";
const NOW = new Date("2026-11-20T15:00:00Z"); // 10:00 EST on 2026-11-20
/** Local midnight of the first day of each calendar window, worked out by hand (EDT is UTC-4, EST UTC-5). */
const START: Record<UsageDays, Date> = {
  7: new Date("2026-11-14T05:00:00Z"),
  30: new Date("2026-10-22T04:00:00Z"),
  90: new Date("2026-08-23T04:00:00Z"),
};
const ROLLING_START = new Date(NOW.getTime() - 7 * 86_400_000);
/** Local midnight that ends today: every calendar window ends here (F4: a later turn has no bar). */
const END = new Date("2026-11-21T05:00:00Z");

let t: Awaited<ReturnType<typeof createTestDb>>;
let usage: UsageService;

type Seed = {
  id: string;
  agentId: string;
  startedAt: Date;
  open: boolean;
  /** Cost in micro-dollars (exact), null for a turn without a usage event. */
  micros: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheWriteTokens: number | null;
  cacheReadTokens: number | null;
  model: string | null;
  taskId: string | null;
  credentialId: string | null;
};
const turns: Seed[] = [];
type AgentFixture = {
  id: string;
  handle: string;
  displayName: string;
  kind: "persistent" | "ephemeral";
  reportsTo?: string;
  archived?: boolean;
  terminated?: boolean;
};
const AGENTS: AgentFixture[] = [
  { id: "a-lead", handle: "lead", displayName: "Lead", kind: "persistent" },
  { id: "a-kid1", handle: "kid1", displayName: "Kid one", kind: "ephemeral", reportsTo: "a-lead" },
  {
    id: "a-kid2",
    handle: "kid2",
    displayName: "Kid two",
    kind: "ephemeral",
    reportsTo: "a-lead",
    terminated: true,
  },
  { id: "a-dev", handle: "dev", displayName: "Dev", kind: "persistent", reportsTo: "a-lead" },
  { id: "a-w1", handle: "w1", displayName: "Busy", kind: "persistent" },
  { id: "a-w2", handle: "w2", displayName: "W2", kind: "persistent" },
  { id: "a-w3", handle: "w3", displayName: "W3", kind: "persistent" },
  { id: "a-w4", handle: "w4", displayName: "W4", kind: "persistent" },
  { id: "a-idle", handle: "idle", displayName: "Idle", kind: "persistent" },
  { id: "a-gone", handle: "gone", displayName: "Gone", kind: "persistent", archived: true },
  { id: "a-old", handle: "old", displayName: "Old", kind: "persistent", archived: true },
  { id: "a-late", handle: "late", displayName: "Late", kind: "persistent" },
];
const TASKS = [
  { id: "task1", title: "Ship it" },
  { id: "task2", title: "Fix it" },
  { id: "task3", title: "Only an open turn" },
  ...Array.from({ length: 22 }, (_, i) => ({ id: `bt${i}`, title: `Busy ${i}` })),
];
const taskKey = new Map<string, string>();

let n = 0;
function turn(
  agentId: string,
  startedAt: string,
  micros: number | null,
  o: { cred?: string | null; model?: string | null; task?: string; open?: boolean } = {},
) {
  n++;
  turns.push({
    id: `turn-${n}`,
    agentId,
    startedAt: new Date(startedAt),
    open: o.open ?? false,
    micros,
    inputTokens: micros === null ? null : 100 + n,
    outputTokens: micros === null ? null : 10 + n,
    cacheWriteTokens: micros === null ? null : n,
    cacheReadTokens: micros === null ? null : 2 * n,
    model: o.model === undefined ? "claude-opus" : o.model,
    taskId: o.task ?? null,
    credentialId: o.cred === undefined ? "c-a" : o.cred,
  });
}

// lead: the DST day (2026-11-01 local), window edges, an open turn and a NULL-cost turn.
turn("a-lead", "2026-11-20T14:00:00Z", 1_500_000, { task: "task1" });
turn("a-lead", "2026-11-01T04:30:00Z", 250_000, { model: "claude-sonnet" }); // 00:30 EDT, Nov 1
turn("a-lead", "2026-11-01T05:30:00Z", 125_000, { cred: "c-b" }); // 01:30 EDT, Nov 1
turn("a-lead", "2026-11-01T06:30:00Z", 62_500, { cred: null }); // 01:30 EST, Nov 1
turn("a-lead", "2026-11-02T04:30:00Z", 31_250, { task: "task2" }); // 23:30 EST, still Nov 1
turn("a-lead", "2026-11-02T05:00:00Z", 500_000); // 00:00 EST, Nov 2
turn("a-lead", "2026-10-22T04:00:00.000Z", 700_000); // exactly the 30-day start
turn("a-lead", "2026-10-22T03:59:59.999Z", 900_000); // 1 ms before it
turn("a-lead", "2026-11-14T05:00:00.000Z", 110_000); // exactly the 7-day calendar start
turn("a-lead", "2026-11-14T04:59:59.999Z", 130_000); // 1 ms before it
turn("a-lead", "2026-11-13T15:00:00.000Z", 170_000); // exactly the rolling 7-day start
turn("a-lead", "2026-11-13T14:59:59.999Z", 190_000); // 1 ms before it
turn("a-lead", "2026-11-19T10:00:00Z", 9_990_000, { task: "task3", open: true });
turn("a-lead", "2026-11-18T10:00:00Z", null, { model: null });
turn("a-lead", "2026-07-01T10:00:00Z", 1_000_000);
// spawned children (one terminated) and a persistent report
turn("a-kid1", "2026-11-19T12:00:00Z", 2_000_000, { task: "task1" });
turn("a-kid1", "2026-11-05T12:00:00Z", 400_000, { cred: "c-b", model: "claude-sonnet" });
turn("a-kid2", "2026-11-10T12:00:00Z", 3_000_000, { task: "task1" });
turn("a-dev", "2026-11-19T13:00:00Z", 5_000_000, { task: "task2" });
turn("a-dev", "2026-11-15T13:00:00Z", 300_000, { cred: null });
// w1 works on 22 tasks (byTask keeps the top 20); w2–w4 make c-a have more than 5 agents
for (let i = 0; i < 22; i++)
  turn("a-w1", `2026-11-${String(10 + (i % 10)).padStart(2, "0")}T16:00:00Z`, (i + 1) * 10_000, {
    task: `bt${i}`,
  });
turn("a-w2", "2026-11-17T12:00:00Z", 600_000);
turn("a-w3", "2026-11-17T12:00:00Z", 800_000);
turn("a-w4", "2026-11-17T12:00:00Z", 1_100_000);
turn("a-gone", "2026-11-16T12:00:00Z", 1_000_000, { cred: "c-b" });
turn("a-old", "2026-08-01T12:00:00Z", 1_000_000);
// late: the last ms of today (local) and the first ms of tomorrow, a turn only clock skew could write
turn("a-late", "2026-11-21T04:59:59.999Z", 20_000);
turn("a-late", "2026-11-21T05:00:00.000Z", 40_000);

const zero = (): Totals => ({
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  turns: 0,
});
/** Sums the seeded objects (closed turns only, NULLs as 0); cost is summed in exact micro-dollars. */
function reference(pred: (s: Seed) => boolean): Totals {
  let micros = 0;
  const r = zero();
  for (const s of turns) {
    if (s.open || !pred(s)) continue;
    micros += s.micros ?? 0;
    r.inputTokens += s.inputTokens ?? 0;
    r.outputTokens += s.outputTokens ?? 0;
    r.cacheWriteTokens += s.cacheWriteTokens ?? 0;
    r.cacheReadTokens += s.cacheReadTokens ?? 0;
    r.turns++;
  }
  r.costUsd = micros / 1e6;
  return r;
}
const add = (a: Totals, b: Totals): Totals => ({
  costUsd: (Math.round(a.costUsd * 1e6) + Math.round(b.costUsd * 1e6)) / 1e6,
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  turns: a.turns + b.turns,
});
const sumOf = (xs: Totals[]) => xs.reduce(add, zero());
const strip = <T extends Totals>(x: T): Totals => ({
  costUsd: x.costUsd,
  inputTokens: x.inputTokens,
  outputTokens: x.outputTokens,
  cacheWriteTokens: x.cacheWriteTokens,
  cacheReadTokens: x.cacheReadTokens,
  turns: x.turns,
});

const localDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const dayOf = (d: Date) => localDay.format(d);
const inCal = (days: UsageDays) => (s: Seed) => s.startedAt >= START[days] && s.startedAt < END;
const inRolling = (s: Seed) => s.startedAt >= ROLLING_START;
/** The calendar days of a window, oldest first, as `YYYY-MM-DD`. */
function windowDays(days: UsageDays): string[] {
  const last = Date.UTC(2026, 10, 20);
  return Array.from({ length: days }, (_, i) =>
    new Date(last - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10),
  );
}
const byId = new Map(AGENTS.map((a) => [a.id, a]));
const childrenOf = (id: string) =>
  AGENTS.filter((a) => a.kind === "ephemeral" && a.reportsTo === id).map((a) => a.id);
const scopeOf = (id: string) =>
  byId.get(id)?.kind === "persistent" ? [id, ...childrenOf(id)] : [id];

beforeAll(async () => {
  t = await createTestDb();
  await t.sql.unsafe(principalSql("u1", "human", "or"));
  await t.sql`insert into users (id, name, email) values ('u1','Or','or@x.io')`;
  for (const a of AGENTS)
    await insertAgent(t.sql, {
      id: a.id,
      handle: a.handle,
      displayName: a.displayName,
      kind: a.kind,
      reportsTo: a.reportsTo ?? undefined,
      archived: a.archived,
      terminatedAt: a.terminated ? "2026-11-11T00:00:00Z" : null,
    });
  await t.sql`insert into credentials (id, name, kind, value_enc, rl_status, rl_type, rl_utilization, rl_resets_at, rl_observed_at)
              values ('c-a', 'alpha', 'oauth_token', ${Buffer.from("x")}, 'allowed_warning', 'five_hour', 0.9,
                      '2026-11-20T18:00:00Z', '2026-11-20T14:30:00Z')`;
  await t.sql`insert into credentials (id, name, kind, value_enc, rate_limited_until, rate_limit_exact)
              values ('c-b', 'beta', 'api_key', ${Buffer.from("x")}, '2026-11-20T16:00:00Z', false)`;
  // a pause that has already passed is not reported
  await t.sql`update credentials set rate_limited_until = '2026-11-20T14:00:00Z' where id = 'cred-a-w2'`;
  // an observation without a status (the writer never does this) reads as allowed, as on the credential list
  await t.sql`insert into credentials (id, name, kind, value_enc, rl_observed_at)
              values ('c-z', 'zeta', 'oauth_token', ${Buffer.from("x")}, '2026-11-20T14:45:00Z')`;
  for (const k of TASKS) {
    const [row] = await t.sql<{ number: number }[]>`
      insert into tasks (id, title, created_by_id) values (${k.id}, ${k.title}, 'u1') returning number`;
    taskKey.set(k.id, `T-${row?.number}`);
  }
  for (const s of turns)
    await insertTurn(t.sql, {
      id: s.id,
      agentId: s.agentId,
      startedAt: s.startedAt,
      endedAt: s.open ? null : undefined,
      costUsd: s.micros === null ? null : s.micros / 1e6,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      cacheWriteTokens: s.cacheWriteTokens,
      cacheReadTokens: s.cacheReadTokens,
      model: s.model,
      taskId: s.taskId,
      credentialId: s.credentialId,
    });
  usage = new UsageService({ db: t.db, now: () => NOW, timezone: () => TZ });
});
afterAll(() => t.close());

test.each([7, 30, 90] as const)(
  "daily(%i) is zero-filled per local day and equals the reference",
  async (days) => {
    const r = await usage.daily(days);
    expect(r.timezone).toBe(TZ);
    expect(r.days.map((d) => d.date)).toEqual(windowDays(days));
    for (const d of r.days)
      expect(strip(d), d.date).toEqual(
        reference((s) => inCal(days)(s) && dayOf(s.startedAt) === d.date),
      );
    expect(sumOf(r.days.map(strip))).toEqual(reference(inCal(days)));
  },
);

test("the DST fall-back day buckets by the local date", async () => {
  const r = await usage.daily(30);
  const nov1 = r.days.find((d) => d.date === "2026-11-01");
  // 00:30 EDT, 01:30 EDT, 01:30 EST and 23:30 EST
  expect(nov1?.turns).toBe(4);
  expect(nov1?.costUsd).toBe(0.46875);
  expect(r.days.find((d) => d.date === "2026-11-02")?.costUsd).toBe(0.5);
});

test("the calendar window includes local midnight of the first day and excludes 1 ms earlier", async () => {
  const first30 = (await usage.daily(30, { agentIds: ["a-lead"] })).days[0];
  expect(first30?.date).toBe("2026-10-22");
  expect(first30?.costUsd).toBe(0.7);
  expect(first30?.turns).toBe(1);
  const first7 = (await usage.daily(7, { agentIds: ["a-lead"] })).days[0];
  expect(first7?.date).toBe("2026-11-14");
  expect(first7?.costUsd).toBe(0.11);
});

test("a scoped daily sums only those agents and equals the agent page total (F4)", async () => {
  const lead = await usage.agent(await refOfHandle(t.db, "lead"), 30);
  const r = await usage.daily(30, { agentIds: scopeOf("a-lead") });
  expect(r.days).toHaveLength(30);
  expect(sumOf(r.days.map(strip))).toEqual(lead?.total);
  expect(lead?.daily).toEqual(r.days);
  const none = await usage.daily(7, { agentIds: [] });
  expect(none.days.every((d) => d.turns === 0 && d.costUsd === 0)).toBe(true);
});

function expectedAgents(pred: (s: Seed) => boolean) {
  return AGENTS.flatMap((a) => {
    const own = reference((s) => pred(s) && s.agentId === a.id);
    const spawned =
      a.kind === "persistent"
        ? reference((s) => pred(s) && childrenOf(a.id).includes(s.agentId))
        : undefined;
    const total = spawned ? add(own, spawned) : own;
    if (total.turns === 0 && !(a.kind === "persistent" && !a.archived)) return [];
    return [
      {
        ref: testRef(a.id),
        handle: a.handle,
        displayName: a.displayName,
        kind: a.kind,
        ...(a.kind === "ephemeral" && a.reportsTo
          ? { spawner: { ref: testRef(a.reportsTo), handle: byId.get(a.reportsTo)?.handle } }
          : {}),
        archived: a.archived ?? false,
        terminated: a.terminated ?? false,
        own,
        ...(spawned ? { spawned } : {}),
        total,
      },
    ];
  }).sort((x, y) => y.total.costUsd - x.total.costUsd || x.handle.localeCompare(y.handle));
}

test.each([7, 30, 90] as const)("agents(calendar %i) equals the reference", async (days) => {
  expect((await usage.agents({ kind: "calendar", days })).agents).toEqual(
    expectedAgents(inCal(days)),
  );
});

test("agents(rolling 7) is the tree's window: now minus 7 days", async () => {
  const r = await usage.agents({ kind: "rolling", days: 7 });
  expect(r.agents).toEqual(expectedAgents(inRolling));
  const lead = r.agents.find((a) => a.handle === "lead");
  // the turn exactly at now - 7d counts, 1 ms earlier does not
  expect(lead?.own.costUsd).toBe((1_500_000 + 110_000 + 130_000 + 170_000) / 1e6);
});

test("a spawner's total is own plus spawned and excludes its persistent reports", async () => {
  const r = await usage.agents({ kind: "calendar", days: 30 });
  const lead = r.agents.find((a) => a.handle === "lead");
  const dev = r.agents.find((a) => a.handle === "dev");
  expect(lead?.total).toEqual(add(lead?.own ?? zero(), lead?.spawned ?? zero()));
  expect(lead?.spawned).toEqual(
    reference((s) => inCal(30)(s) && ["a-kid1", "a-kid2"].includes(s.agentId)),
  );
  expect(dev?.total.turns).toBeGreaterThan(0);
  expect(lead?.total).toEqual(
    reference((s) => inCal(30)(s) && scopeOf("a-lead").includes(s.agentId)),
  );
  // idle (live, no turns) is listed with zeros; old (archived, no turns in the window) is not
  expect(r.agents.find((a) => a.handle === "idle")?.total).toEqual(zero());
  expect(r.agents.find((a) => a.handle === "old")).toBeUndefined();
  expect(r.agents.find((a) => a.handle === "gone")?.archived).toBe(true);
});

test("credentials(30): totals, top 5 agents by cost, rate-limit state and unattributed", async () => {
  const r = await usage.credentials(30);
  const pred = inCal(30);
  expect(r.unattributed).toEqual(reference((s) => pred(s) && s.credentialId === null));
  expect(r.unattributed.turns).toBe(2);
  const names = (await t.sql<{ name: string }[]>`select name from credentials order by name`).map(
    (x) => x.name,
  );
  expect(r.credentials.map((c) => c.name)).toEqual(names);

  const alpha = r.credentials.find((c) => c.name === "alpha");
  expect(alpha?.kind).toBe("oauth_token");
  expect(alpha?.totals).toEqual(reference((s) => pred(s) && s.credentialId === "c-a"));
  const perAgent = AGENTS.map((a) => ({
    ref: testRef(a.id),
    handle: a.handle,
    costUsd: reference((s) => pred(s) && s.credentialId === "c-a" && s.agentId === a.id).costUsd,
    turns: reference((s) => pred(s) && s.credentialId === "c-a" && s.agentId === a.id).turns,
  }))
    .filter((x) => x.turns > 0)
    .sort((x, y) => y.costUsd - x.costUsd || x.handle.localeCompare(y.handle));
  expect(perAgent.length).toBeGreaterThan(5);
  expect(alpha?.agents).toEqual(
    perAgent.slice(0, 5).map(({ ref, handle, costUsd }) => ({ ref, handle, costUsd })),
  );
  expect(alpha?.rateLimit).toEqual({
    status: "allowed_warning",
    type: "five_hour",
    utilization: expect.closeTo(0.9, 5),
    resetsAt: "2026-11-20T18:00:00.000Z",
    observedAt: "2026-11-20T14:30:00.000Z",
  });
  expect(alpha?.pausedUntil).toBeUndefined();

  const beta = r.credentials.find((c) => c.name === "beta");
  expect(beta?.kind).toBe("api_key");
  expect(beta?.totals).toEqual(reference((s) => pred(s) && s.credentialId === "c-b"));
  expect(beta?.rateLimit).toBeNull();
  expect(beta?.pausedUntil).toBe("2026-11-20T16:00:00.000Z");
  expect(beta?.pauseExact).toBe(false);

  const w2cred = r.credentials.find((c) => c.name === "cred-a-w2");
  expect(w2cred?.totals).toEqual(zero());
  expect(w2cred?.agents).toEqual([]);
  expect(w2cred?.pausedUntil).toBeUndefined();
  expect(w2cred?.pauseExact).toBeUndefined();

  expect(r.credentials.find((c) => c.name === "zeta")?.rateLimit).toEqual({
    status: "allowed",
    type: null,
    utilization: null,
    resetsAt: null,
    observedAt: "2026-11-20T14:45:00.000Z",
  });
});

test("a calendar window ends at local midnight tonight, so its totals equal the sum of its bars (F4)", async () => {
  const late = (await usage.agents({ kind: "calendar", days: 7 })).agents.find(
    (a) => a.handle === "late",
  );
  expect(late?.own).toMatchObject({ turns: 1, costUsd: 0.02 });
  const page = await usage.agent(await refOfHandle(t.db, "late"), 7);
  expect(page?.total).toMatchObject({ turns: 1, costUsd: 0.02 });
  expect(sumOf(page?.daily.map(strip) ?? [])).toEqual(page?.total);
  const alpha = (await usage.credentials(7)).credentials.find((c) => c.name === "alpha");
  const daily = await usage.daily(7, { agentIds: AGENTS.map((a) => a.id) });
  expect(alpha?.totals).toEqual(reference((s) => inCal(7)(s) && s.credentialId === "c-a"));
  expect(sumOf(daily.days.map(strip))).toEqual(reference(inCal(7)));
});

test("agent(lead, 30): spawner scope, by model, by task, spawned", async () => {
  const pred = inCal(30);
  const scope = scopeOf("a-lead");
  const r = await usage.agent(await refOfHandle(t.db, "lead"), 30);
  expect(r?.agent).toEqual({
    ref: testRef("a-lead"),
    handle: "lead",
    displayName: "Lead",
    kind: "persistent",
  });
  expect(r?.timezone).toBe(TZ);
  expect(r?.own).toEqual(reference((s) => pred(s) && s.agentId === "a-lead"));
  expect(r?.total).toEqual(reference((s) => pred(s) && scope.includes(s.agentId)));
  expect(r?.daily).toHaveLength(30);
  expect(sumOf(r?.daily.map(strip) ?? [])).toEqual(r?.total);

  const models = [...new Set(turns.filter((s) => scope.includes(s.agentId)).map((s) => s.model))];
  const byModel = models
    .map((m) => ({
      model: m,
      ...reference((s) => pred(s) && scope.includes(s.agentId) && s.model === m),
    }))
    .filter((x) => x.turns > 0)
    // ties by model name, a NULL model last (Postgres's ascending order)
    .sort(
      (x, y) =>
        y.costUsd - x.costUsd ||
        (x.model === null ? 1 : y.model === null ? -1 : x.model.localeCompare(y.model)),
    );
  expect(r?.byModel).toEqual(byModel);
  // a turn without a model is reported as null: the UI owns its label
  expect(r?.byModel.find((m) => m.model === null)).toMatchObject({ turns: 1, costUsd: 0 });

  const byTask = ["task1", "task2"]
    .map((id) => ({
      key: taskKey.get(id) ?? "",
      title: TASKS.find((k) => k.id === id)?.title ?? "",
      ...reference((s) => pred(s) && scope.includes(s.agentId) && s.taskId === id),
    }))
    .sort((x, y) => y.costUsd - x.costUsd);
  expect(r?.byTask).toEqual(byTask);

  expect(r?.spawned).toEqual([
    {
      ref: testRef("a-kid2"),
      handle: "kid2",
      displayName: "Kid two",
      terminated: true,
      ...reference((s) => pred(s) && s.agentId === "a-kid2"),
    },
    {
      ref: testRef("a-kid1"),
      handle: "kid1",
      displayName: "Kid one",
      terminated: false,
      ...reference((s) => pred(s) && s.agentId === "a-kid1"),
    },
  ]);
});

test("agent(): a spawned agent's figure is its own; byTask holds the top 20; unknown handle", async () => {
  const kid = await usage.agent(await refOfHandle(t.db, "kid1"), 90);
  expect(kid?.agent.kind).toBe("ephemeral");
  expect(kid?.total).toEqual(reference((s) => s.agentId === "a-kid1" && inCal(90)(s)));
  expect(kid?.own).toEqual(kid?.total);
  expect(kid?.spawned).toEqual([]);

  const w1 = await usage.agent(await refOfHandle(t.db, "w1"), 30);
  expect(w1?.byTask).toHaveLength(20);
  expect(w1?.byTask[0]).toMatchObject({
    key: taskKey.get("bt21"),
    title: "Busy 21",
    costUsd: 0.22,
    turns: 1,
  });
  expect(w1?.byTask.map((x) => x.key)).not.toContain(taskKey.get("bt0"));
  expect(w1?.byTask.map((x) => x.key)).not.toContain(taskKey.get("bt1"));

  const idle = await usage.agent(await refOfHandle(t.db, "idle"), 7);
  expect(idle?.total).toEqual(zero());
  expect(idle?.daily).toHaveLength(7);
  expect(idle?.byModel).toEqual([]);
  expect(await usage.agent(UNKNOWN_REF, 30)).toBeUndefined();
});

test("task(): attributed closed turns, any time; null without them", async () => {
  expect(await usage.task("task1")).toEqual({
    costUsd: (1_500_000 + 2_000_000 + 3_000_000) / 1e6,
    turns: 3,
  });
  expect(await usage.task("task2")).toEqual({ costUsd: (31_250 + 5_000_000) / 1e6, turns: 2 });
  // only an open turn carries task3
  expect(await usage.task("task3")).toBeNull();
  expect(await usage.task("no-such-task")).toBeNull();
});

test("the open turn is excluded everywhere and the NULL-cost turn counts with $0", async () => {
  // Every other test's reference skips open turns; here the lead's own days show it directly.
  const lead = await usage.daily(7, { agentIds: ["a-lead"] });
  const d19 = lead.days.find((d) => d.date === "2026-11-19");
  expect(d19).toMatchObject({ turns: 0, costUsd: 0 }); // only the open turn started that day
  const d18 = lead.days.find((d) => d.date === "2026-11-18");
  expect(d18).toMatchObject({ turns: 1, costUsd: 0, inputTokens: 0, cacheReadTokens: 0 });
  const page = await usage.agent(await refOfHandle(t.db, "lead"), 7);
  expect(page?.byTask.map((k) => k.key)).not.toContain(taskKey.get("task3"));
  const tree = await usage.agents({ kind: "rolling", days: 7 });
  expect(tree.agents.find((a) => a.handle === "lead")?.own.turns).toBe(5);
});
