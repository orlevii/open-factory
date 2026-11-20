import { expect, test } from "vitest";
import { type RateLimitColumns, toRateLimitState } from "./rate-limit-state.ts";

/** S10 §7: one mapping of a credential's rate-limit columns, shared by the credential list and Settings → Usage. */
const NOW = new Date("2026-11-20T15:00:00Z");
const none: RateLimitColumns = {
  rlStatus: null,
  rlType: null,
  rlUtilization: null,
  rlResetsAt: null,
  rlObservedAt: null,
  rateLimitedUntil: null,
  rateLimitExact: true,
};

test("no observation: no state and no pause", () => {
  expect(toRateLimitState(none, NOW)).toEqual({ rateLimit: null });
});

test("an observation maps every column, timestamps as ISO", () => {
  expect(
    toRateLimitState(
      {
        ...none,
        rlStatus: "allowed_warning",
        rlType: "five_hour",
        rlUtilization: 0.9,
        rlResetsAt: new Date("2026-11-20T18:00:00Z"),
        rlObservedAt: new Date("2026-11-20T14:30:00Z"),
      },
      NOW,
    ),
  ).toEqual({
    rateLimit: {
      status: "allowed_warning",
      type: "five_hour",
      utilization: 0.9,
      resetsAt: "2026-11-20T18:00:00.000Z",
      observedAt: "2026-11-20T14:30:00.000Z",
    },
  });
});

test("an observation without a status reads as allowed", () => {
  const r = toRateLimitState({ ...none, rlObservedAt: new Date("2026-11-20T14:30:00Z") }, NOW);
  expect(r.rateLimit).toEqual({
    status: "allowed",
    type: null,
    utilization: null,
    resetsAt: null,
    observedAt: "2026-11-20T14:30:00.000Z",
  });
});

test("a pause shows only while it is in the future", () => {
  const until = new Date("2026-11-20T16:00:00Z");
  expect(
    toRateLimitState({ ...none, rateLimitedUntil: until, rateLimitExact: false }, NOW),
  ).toEqual({ rateLimit: null, pausedUntil: "2026-11-20T16:00:00.000Z", pauseExact: false });
  expect(toRateLimitState({ ...none, rateLimitedUntil: NOW }, NOW)).toEqual({ rateLimit: null });
});
