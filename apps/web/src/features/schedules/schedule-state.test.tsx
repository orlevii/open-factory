import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { ScheduleState } from "./schedule-state";
import { ScheduleTime } from "./schedule-time";

test.each([
  ["active", "Active"],
  ["paused", "Paused"],
  ["done", "Done"],
  ["skipped_archived", "Skipped"],
  ["pending_errored", "Waiting"],
] as const)("%s shows an icon and the label %s, never orange", (state, label) => {
  const { container } = render(<ScheduleState state={state} />);
  expect(screen.getByText(label)).toBeInTheDocument();
  expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  expect(container.innerHTML).not.toMatch(/orange|primary/);
});

test("ScheduleTime is a <time> with the ISO instant, the zone muted, and a title naming the zone", () => {
  render(
    <ScheduleTime
      at="2026-11-23T08:00:00.000Z"
      zone="Asia/Tokyo"
      now={new Date("2026-11-20T10:00:00Z")}
    />,
  );
  const t = screen.getByText("Mon 23 Nov 17:00");
  expect(t.tagName).toBe("TIME");
  expect(t).toHaveAttribute("datetime", "2026-11-23T08:00:00.000Z");
  expect(t.getAttribute("title")).toContain("Asia/Tokyo");
  expect(screen.getByText("Asia/Tokyo")).toBeInTheDocument();
});
