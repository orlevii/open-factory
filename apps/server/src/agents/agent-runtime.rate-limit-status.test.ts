import type { HarnessEvent } from "@open-factory/shared";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { CredentialPause } from "../supervisor/slots.ts";
import { ev } from "./testing/fake-driver.ts";
import { insertAgent } from "./testing/rows.ts";
import { RuntimeHarness } from "./testing/runtime-harness.ts";
import { RecordingSlots } from "./testing/slots.ts";

const h = new RuntimeHarness();
let slots: PausableSlots;
/** Records every credential pause the runtime asks for. */
class PausableSlots extends RecordingSlots {
  readonly pauses: [string, Date, boolean][] = [];
  override pause(credentialId: string, until: Date, exact: boolean) {
    this.pauses.push([credentialId, until, exact]);
  }
  override pauseOf(): CredentialPause | undefined {
    return undefined;
  }
}
beforeAll(() => h.setup());
afterAll(() => h.close());
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  slots = new PausableSlots();
  await h.makeRuntime({ slots });
  return () => vi.useRealTimers();
});

const status = (
  s: Partial<Extract<HarnessEvent, { type: "rate_limit_status" }>>,
): HarnessEvent => ({
  type: "rate_limit_status",
  status: "allowed_warning",
  rateLimitType: "five_hour",
  utilization: 0.82,
  resetsAt: 1795209600,
  ...s,
});

async function cred(id = `cred-${h.agentId}`) {
  const [r] = await h.t
    .sql`select rl_status, rl_type, rl_utilization, rl_resets_at, rl_observed_at, rate_limited_until
    from credentials where id = ${id}`;
  return r;
}
async function sessionEvents() {
  const [r] = await h.t
    .sql`select count(*)::int as n from session_events where agent_id = ${h.agentId}`;
  return r?.n as number;
}
async function busy() {
  await h.send("go");
  h.driver.last.emit(ev.session(), ev.turn());
  await h.rt.settled();
}

test("a status event updates the credential's rl_* columns, appends nothing and pauses nothing", async () => {
  await busy();
  const before = await sessionEvents();
  h.driver.last.emit(status({}));
  await h.rt.settled();
  const r = await cred();
  expect(r?.rl_status).toBe("allowed_warning");
  expect(r?.rl_type).toBe("five_hour");
  expect(r?.rl_utilization).toBeCloseTo(0.82);
  expect(new Date(r?.rl_resets_at).getTime()).toBe(1795209600_000);
  expect(await sessionEvents()).toBe(before);
  expect(slots.pauses).toEqual([]);
  expect(r?.rate_limited_until).toBeNull();
});

test("the status is recorded on the credential the process was launched with, not the row's current one", async () => {
  await busy();
  await insertAgent(h.t.sql, { id: `${h.agentId}-other`, slug: `${h.agentId}-other` });
  await h.t
    .sql`update agents set credential_id = ${`cred-${h.agentId}-other`} where id = ${h.agentId}`;
  await h.rt.reload();
  h.driver.last.emit(status({}));
  await h.rt.settled();
  expect(h.driver.starts).toHaveLength(1); // still the launch process
  expect((await cred())?.rl_status).toBe("allowed_warning");
  expect((await cred(`cred-${h.agentId}-other`))?.rl_status).toBeNull();
});

test("a status without a window type stores NULL, not an invented type", async () => {
  await busy();
  h.driver.last.emit({ type: "rate_limit_status", status: "allowed" });
  await h.rt.settled();
  const r = await cred();
  expect(r?.rl_status).toBe("allowed");
  expect(r?.rl_type).toBeNull();
});

test("a status write leaves the credential's updated_at alone (it means the credential was edited)", async () => {
  await busy();
  const id = `cred-${h.agentId}`;
  await h.t.sql`update credentials set updated_at = '2026-01-01T00:00:00Z' where id = ${id}`;
  h.driver.last.emit(status({}));
  await h.rt.settled();
  const [r] = await h.t.sql`select rl_status, updated_at from credentials where id = ${id}`;
  expect(r?.rl_status).toBe("allowed_warning");
  expect(new Date(r?.updated_at).toISOString()).toBe("2026-01-01T00:00:00.000Z");
});

test("an older observation does not overwrite a newer one", async () => {
  await busy();
  vi.setSystemTime(new Date("2026-11-20T10:00:00Z"));
  h.driver.last.emit(status({ status: "allowed_warning", utilization: 0.9 }));
  await h.rt.settled();
  vi.setSystemTime(new Date("2026-11-20T09:00:00Z"));
  h.driver.last.emit(status({ status: "allowed", utilization: 0.1 }));
  await h.rt.settled();
  const r = await cred();
  expect(r?.rl_status).toBe("allowed_warning");
  expect(r?.rl_utilization).toBeCloseTo(0.9);
});

test("a failed status write never fails the turn", async () => {
  await busy();
  const spy = vi.spyOn(h.store, "recordRateLimit").mockRejectedValue(new Error("db down"));
  h.driver.last.emit(status({}), ev.usage(), ev.end());
  await h.rt.settled();
  spy.mockRestore();
  const proc = h.driver.last;
  expect(h.rt.statusFrame().status).not.toBe("errored");
  const [turn] = await h.t.sql`select ended_at from turns where agent_id = ${h.agentId}`;
  expect(turn?.ended_at).not.toBeNull();
  expect(h.driver.starts).toHaveLength(1);
  expect(proc.stopped).toBe(false); // the live process was never stopped
});
