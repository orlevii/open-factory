import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { StatusBadge, statusAnnouncement } from "./status-badge";

const todayAt = (h: number, m: number) => {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

test("working renders the tooth, never a dot; others render a dot + label", () => {
  const { container } = render(<StatusBadge status="working" size="long" />);
  expect(container.querySelector(".of-tooth")).not.toBeNull();
  expect(container.querySelector("[data-status-dot]")).toBeNull();
});

test.each([
  ["hibernated", "Hibernated"],
  ["queued", "Queued"],
  ["idle", "Idle"],
  ["errored", "Errored"],
] as const)("%s renders a dot and its label, no tooth", (status, label) => {
  const { container } = render(<StatusBadge status={status} size="long" />);
  expect(screen.getByText(label)).toBeInTheDocument();
  expect(container.querySelector("[data-status-dot]")).not.toBeNull();
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
    expect(statusAnnouncement("Team Lead", "rate_limited", reset(true))).toBe(
      "Team Lead is rate-limited until 14:30",
    );
    expect(statusAnnouncement("Team Lead", "rate_limited", reset(false))).toBe(
      "Team Lead is rate-limited, retrying at 14:30",
    );
  });
});
