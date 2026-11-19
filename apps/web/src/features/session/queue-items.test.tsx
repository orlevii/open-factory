import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { agentSummary } from "@/test/session-fixtures";
import { QueueItems } from "./queue-items";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "setInterval"] });
  vi.setSystemTime(new Date(2026, 10, 19, 14, 0));
});
afterEach(() => vi.useRealTimers());

const local = (h: number, m: number) => new Date(2026, 10, 19, h, m).toISOString();
const held = (o: Record<string, unknown>) =>
  ({ id: "m1", kind: "held", from: "dev", count: 3, createdAt: local(13, 59), ...o }) as never;
/** The line's whole text: the `@slug` is its own mono element inside it. */
const line = (text: string) =>
  screen.getByText((_, el) => el?.tagName === "SPAN" && el.textContent === text);

test.each([
  [{ waitReason: "turn" }, "3 updates from @dev waiting for this turn to end"],
  [
    { waitReason: "window", dueAt: local(14, 32) },
    "3 updates from @dev waiting, delivered by 14:32",
  ],
  [{ waitReason: "starting" }, "3 updates from @dev waiting for this agent to start"],
  [{ waitReason: "errored" }, "3 updates from @dev held until a human restarts this agent"],
  [{ waitReason: "turn", count: 1 }, "1 update from @dev waiting for this turn to end"],
])("held line %o", (o, text) => {
  render(<QueueItems items={[held(o)]} agent={agentSummary()} />);
  expect(line(text)).toBeInTheDocument();
  expect(screen.getByText("@dev")).toHaveClass("font-mono");
});

test("rate-limited uses S5's reset phrase; peer events collapse into one line; nothing ticks", () => {
  render(
    <QueueItems
      items={[
        held({ waitReason: "rate_limited" }),
        held({ id: "p1", from: "@factory", count: 2, waitReason: "ride_along" }),
        held({ id: "p2", from: "@factory", count: 1, waitReason: "ride_along" }),
      ]}
      agent={agentSummary({
        status: "rate_limited",
        rateLimitedUntil: local(14, 30),
        rateLimitExact: true,
      })}
    />,
  );
  expect(line("3 updates from @dev held until 14:30")).toBeInTheDocument();
  expect(screen.getAllByText("3 peer changes waiting")).toHaveLength(1);
  const before = document.body.innerHTML;
  vi.advanceTimersByTime(5_000);
  expect(document.body.innerHTML).toBe(before);
});

test("rate-limited with an unreported window says retrying", () => {
  render(
    <QueueItems
      items={[held({ waitReason: "rate_limited" })]}
      agent={agentSummary({
        status: "rate_limited",
        rateLimitedUntil: local(14, 30),
        rateLimitExact: false,
      })}
    />,
  );
  expect(line("3 updates from @dev held retrying at 14:30")).toBeInTheDocument();
});

test("a group whose first row is a factory fact is from the report, never @@factory", () => {
  render(
    <QueueItems
      items={[held({ from: "@factory", about: "dev", waitReason: "turn" })]}
      agent={agentSummary()}
    />,
  );
  expect(line("3 updates from @dev waiting for this turn to end")).toBeInTheDocument();
});
