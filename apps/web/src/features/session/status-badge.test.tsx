import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { StatusBadge, statusAnnouncement } from "./status-badge";

// Pinned so "today 14:30" never crosses midnight while the suite runs.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 19, 10, 0));
});
afterEach(() => vi.useRealTimers());
const todayAt = (h: number, m: number) => new Date(2026, 10, 19, h, m).toISOString();

test("working renders the tooth, never a dot; others render a dot + label", () => {
  const { container } = render(<StatusBadge status="working" size="long" />);
  expect(container.querySelector(".of-tooth")).not.toBeNull();
  expect(container.querySelector("[data-status-dot]")).toBeNull();
});

test("errored renders the alert mark and still its label", () => {
  const { container } = render(<StatusBadge status="errored" size="long" />);
  expect(container.querySelector('[data-status-mark="errored"]')).not.toBeNull();
  expect(screen.getByText("Errored")).toBeInTheDocument();
});

test.each([
  ["hibernated", "Hibernated"],
  ["idle", "Idle"],
] as const)("%s renders a dot and its label, no tooth", (status, label) => {
  const { container } = render(<StatusBadge status={status} size="long" />);
  expect(screen.getByText(label)).toBeInTheDocument();
  expect(container.querySelector("[data-status-dot]")).not.toBeNull();
  expect(container.querySelector(".of-tooth")).toBeNull();
});

test("terminated renders its label: no dot, no tooth (an end state)", () => {
  const { container } = render(<StatusBadge status="terminated" size="long" />);
  expect(screen.getByText("Terminated")).toBeInTheDocument();
  expect(container.querySelector("[data-status-dot]")).toBeNull();
  expect(container.querySelector(".of-tooth")).toBeNull();
});

test.each([
  [true, "Rate-limited until 14:30"],
  [false, "Rate-limited, retrying at 14:30"],
])("rate-limited long label (exact=%s)", (exact, label) => {
  render(
    <StatusBadge
      status="rate_limited"
      rateLimitedUntil={todayAt(14, 30)}
      rateLimitExact={exact}
      size="long"
    />,
  );
  expect(screen.getByText(label)).toBeInTheDocument();
});

test("short label never has a time", () => {
  render(
    <StatusBadge
      status="rate_limited"
      rateLimitedUntil={todayAt(14, 30)}
      rateLimitExact
      size="short"
    />,
  );
  expect(screen.getByText("Rate-limited")).toBeInTheDocument();
});

describe("announcements", () => {
  const reset = (exact: boolean) => ({ rateLimitedUntil: todayAt(14, 30), rateLimitExact: exact });
  test("strings", () => {
    expect(statusAnnouncement("Team Lead", "working")).toBe("Team Lead is working");
    expect(statusAnnouncement("Team Lead", "queued")).toBe("Team Lead is queued");
    expect(statusAnnouncement("Team Lead", "idle")).toBe("Team Lead is idle");
    expect(statusAnnouncement("Team Lead", "errored")).toBe("Team Lead is errored");
    expect(statusAnnouncement("Team Lead", "hibernated")).toBe("Team Lead is hibernated");
    expect(statusAnnouncement("Tech Lead · ab12", "terminated")).toBe(
      "Tech Lead · ab12 was terminated",
    );
    expect(statusAnnouncement("Team Lead", "rate_limited", reset(true))).toBe(
      "Team Lead is rate-limited until 14:30",
    );
    expect(statusAnnouncement("Team Lead", "rate_limited", reset(false))).toBe(
      "Team Lead is rate-limited, retrying at 14:30",
    );
  });
});
