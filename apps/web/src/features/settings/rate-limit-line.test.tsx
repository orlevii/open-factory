import type { RateLimitState } from "@open-factory/shared";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RateLimitLine } from "./rate-limit-line";

// 20 Nov 2026, 12:00 local time.
const NOW = new Date(2026, 10, 20, 12, 0);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

const minutesFromNow = (m: number) => new Date(NOW.getTime() + m * 60_000).toISOString();
const rl = (o: Partial<RateLimitState> = {}): RateLimitState => ({
  status: "allowed",
  type: "five_hour",
  utilization: null,
  resetsAt: null,
  observedAt: minutesFromNow(-5),
  ...o,
});

/** The line's text and whether it carries a hidden icon next to it. */
function line(props: Parameters<typeof RateLimitLine>[0]) {
  const { container, unmount } = render(<RateLimitLine {...props} />);
  const text = container.textContent;
  const icon = container.querySelector("svg");
  const out = { text, icon: icon?.getAttribute("aria-hidden"), cls: icon?.getAttribute("class") };
  unmount();
  return out;
}

test("a live pause wins over everything: Rate-limited until 14:30, warning icon", () => {
  const until = new Date(2026, 10, 20, 14, 30).toISOString();
  const r = line({ rateLimit: rl({ status: "rejected" }), pausedUntil: until, pauseExact: true });
  expect(r.text).toBe("Rate-limited until 14:30");
  expect(r.icon).toBe("true");
  expect(r.cls).toContain("text-warning");
  // Even with no observation at all.
  expect(line({ rateLimit: null, pausedUntil: until }).text).toBe("Rate-limited until 14:30");
});

test("a pause without a reported window says when it retries", () => {
  const until = new Date(2026, 10, 20, 14, 30).toISOString();
  expect(line({ rateLimit: null, pausedUntil: until, pauseExact: false }).text).toBe(
    "Rate-limited, retrying at 14:30",
  );
});

test("no observation: No rate-limit data yet", () => {
  const r = line({ rateLimit: null });
  expect(r.text).toBe("No rate-limit data yet");
  expect(r.icon).toBe("true");
});

test("a past pause is not a pause", () => {
  expect(line({ rateLimit: null, pausedUntil: minutesFromNow(-1) }).text).toBe(
    "No rate-limit data yet",
  );
});

test("a warning with a future reset: 82% of the 5-hour limit used, warning icon", () => {
  const r = line({
    rateLimit: rl({ status: "allowed_warning", utilization: 0.82, resetsAt: minutesFromNow(90) }),
  });
  expect(r.text).toBe("82% of the 5-hour limit used");
  expect(r.icon).toBe("true");
  expect(r.cls).toContain("text-warning");
});

test("a warning names the 7-day window, passes others through, and without utilization is Near", () => {
  const warn = (o: Partial<RateLimitState>) =>
    line({ rateLimit: rl({ status: "allowed_warning", resetsAt: minutesFromNow(90), ...o }) }).text;
  expect(warn({ type: "seven_day", utilization: 0.9 })).toBe("90% of the 7-day limit used");
  expect(warn({ type: "opus_weekly", utilization: 0.9 })).toBe("90% of the opus_weekly limit used");
  expect(warn({ utilization: null })).toBe("Near the 5-hour limit");
});

test("a warning without resetsAt is near the limit for an hour after it was seen", () => {
  expect(
    line({
      rateLimit: rl({ status: "allowed_warning", observedAt: minutesFromNow(-30) }),
    }).text,
  ).toBe("Near the 5-hour limit");
  expect(
    line({
      rateLimit: rl({ status: "allowed_warning", observedAt: minutesFromNow(-120) }),
    }).text,
  ).toBe("Within limits · seen 2 hours ago");
});

test("an observation ahead of this clock (skew) reads seen just now, never in the future", () => {
  expect(line({ rateLimit: rl({ observedAt: minutesFromNow(2) }) }).text).toBe(
    "Within limits · seen just now",
  );
});

test("a warning whose reset has passed: Within limits · seen 5 minutes ago, with an icon", () => {
  const r = line({
    rateLimit: rl({ status: "allowed_warning", utilization: 0.82, resetsAt: minutesFromNow(-10) }),
  });
  expect(r.text).toBe("Within limits · seen 5 minutes ago");
  expect(r.icon).toBe("true");
  expect(r.cls).not.toContain("text-warning");
});
