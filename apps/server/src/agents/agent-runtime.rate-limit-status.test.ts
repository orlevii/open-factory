import type { HarnessEvent } from "@open-factory/shared";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { CredentialPause } from "../supervisor/slots.ts";
import { ev } from "./testing/fake-driver.ts";
import { RuntimeHarness } from "./testing/runtime-harness.ts";
import { RecordingSlots } from "./testing/slots.ts";

const h = new RuntimeHarness();
let slots: PausableSlots;
class PausableSlots extends RecordingSlots {
  paused: CredentialPause | undefined;
  override pauseOf(): CredentialPause | undefined {
    return this.paused;
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

async function cred() {
  const [r] = await h.t
    .sql`select c.rl_status, c.rl_type, c.rl_utilization, c.rl_resets_at, c.rl_observed_at
    from credentials c join agents a on a.credential_id = c.id where a.id = ${h.agentId}`;
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
  expect(slots.pauseOf()).toBeUndefined();
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
  expect(h.rt.statusFrame().status).not.toBe("errored");
});
