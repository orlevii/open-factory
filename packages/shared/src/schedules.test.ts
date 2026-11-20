import { expect, test } from "vitest";
import { anyEventSchema } from "./events.ts";
import { MESSAGE_KINDS } from "./messaging.ts";
import {
  createScheduleBodySchema,
  scheduleItemSchema,
  scheduleMessageToolSchema,
} from "./schedules.ts";
import { serverMessageSchema } from "./ws.ts";

test("the tool schema accepts a weekday cron and refuses a nickname with the 5-fields sentence", () => {
  expect(scheduleMessageToolSchema.safeParse({ body: "x", cron: "0 9 * * 1-5" }).success).toBe(
    true,
  );
  const r = scheduleMessageToolSchema.safeParse({ body: "x", cron: "@daily" });
  expect(r.success).toBe(false);
  expect(r.error?.issues[0]?.message).toBe(
    "Use 5 fields: minute hour day-of-month month day-of-week.",
  );
});
test("an unknown zone names the zone", () => {
  const r = scheduleMessageToolSchema.safeParse({
    body: "x",
    at: "2030-01-01T00:00",
    timezone: "Mars/Base",
  });
  expect(r.error?.issues[0]?.message).toBe(
    "Unknown time zone 'Mars/Base'; use an IANA name such as Europe/Berlin.",
  );
});
test("body limits", () => {
  expect(scheduleMessageToolSchema.safeParse({ body: "" }).success).toBe(false);
  expect(scheduleMessageToolSchema.safeParse({ body: "x".repeat(64 * 1024 + 1) }).success).toBe(
    false,
  );
  expect(scheduleMessageToolSchema.safeParse({ body: "x".repeat(64 * 1024) }).success).toBe(true);
});
test("create requires a timezone", () => {
  expect(
    createScheduleBodySchema.safeParse({ target: "ceo", cron: "0 9 * * *", body: "x" }).success,
  ).toBe(false);
  expect(
    createScheduleBodySchema.safeParse({
      target: "ceo",
      cron: "0 9 * * *",
      body: "x",
      timezone: "UTC",
    }).success,
  ).toBe(true);
});
test("an item parses with either author kind", () => {
  const base = {
    key: "S-1",
    target: { slug: "ceo", displayName: "CEO", archived: false, terminated: false },
    cron: "0 9 * * *",
    timezone: "UTC",
    body: "x",
    nextRunAt: null,
    lastFiredAt: null,
    paused: false,
    done: false,
    pendingFiring: false,
    state: "active",
  };
  const human = { kind: "user", handle: "or" };
  const agent = { kind: "agent", slug: "ceo", archived: false, terminated: false };
  expect(
    scheduleItemSchema.safeParse({ ...base, createdBy: human, bodyAuthor: agent }).success,
  ).toBe(true);
  expect(
    scheduleItemSchema.safeParse({ ...base, createdBy: agent, bodyAuthor: human }).success,
  ).toBe(true);
});
test("the scheduled kind, the crons_stopped reasons and the frame", () => {
  expect(MESSAGE_KINDS).toContain("scheduled");
  expect(
    anyEventSchema.safeParse({ type: "hibernated", reason: "crons_stopped", by: "@or" }).success,
  ).toBe(true);
  expect(
    anyEventSchema.safeParse({
      type: "background_work_lost",
      reason: "crons_stopped",
      by: "@or",
      tasks: [],
      crons: [],
    }).success,
  ).toBe(true);
  expect(
    anyEventSchema.safeParse({ type: "process_started", resumed: false, reason: "scheduled" })
      .success,
  ).toBe(true);
  expect(serverMessageSchema.safeParse({ type: "schedules_changed" }).success).toBe(true);
});
