import type { AnyEvent } from "@open-factory/shared";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resetSeq, se } from "@/test/session-fixtures";
import { buildRows } from "./rows";
import { TimelineRow } from "./timeline-row";

const NOW = new Date(2026, 10, 19, 10, 0);
const todayAt = (h: number, m: number) => new Date(2026, 10, 19, h, m).toISOString();
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  resetSeq();
});
afterEach(() => vi.useRealTimers());

/** Renders the rows the events produce; returns each top-level row's text. */
function lines(events: AnyEvent[], spawned = false) {
  const rows = buildRows(events.map((e) => se(e, null)));
  const { container } = render(
    <div>
      {rows.map((row) => (
        <div key={row.key} data-row>
          <TimelineRow
            slug="dev"
            spawned={spawned}
            row={row}
            expanded={new Set()}
            toggle={() => {}}
            rowProps={() => ({})}
            failedIds={new Set()}
            interruptedEnds={new Set()}
          />
        </div>
      ))}
    </div>,
  );
  const els = [...container.querySelectorAll<HTMLElement>("[data-row]")];
  // A row with a detail shows only its summary until expanded.
  const texts = els.map((e) => (e.querySelector("summary") ?? e).textContent);
  return { texts, els };
}

test("timeline: rate_limited renders nothing; rate_limit_paused follows the fallback rule", () => {
  const { texts, els } = lines([
    { type: "rate_limited", status: "rejected", resetsAt: 1, rateLimitType: "five_hour" },
    { type: "rate_limit_paused", credential: "work", until: todayAt(14, 30), exact: true },
    { type: "rate_limit_paused", credential: "work", until: todayAt(14, 30), exact: false },
    { type: "rate_limit_reset", credential: "work" },
  ]);
  expect(texts).toEqual([
    "Rate limit reached on credential work. Paused until 14:30.",
    "Rate limit reached on credential work. Paused, retrying at 14:30.",
    "Rate limit on credential work reset",
  ]);
  for (const el of els) expect(within(el).getByText("work")).toHaveClass("font-mono");
});

test("timeline: hibernated, process_started reasons (nothing after session_reset), cleanup, stop_escalated, background_work_lost, reconciled, unexpected exited as 'Stopped unexpectedly'", () => {
  const { texts, els } = lines([
    { type: "hibernated", reason: "warm_window", idleMinutes: 70 },
    { type: "hibernated", reason: "freed_slot" },
    { type: "hibernated", reason: "apply_changes" },
    { type: "hibernated", reason: "shutdown" },
    { type: "hibernated", reason: "archived" },
    { type: "process_started", resumed: true, reason: "message" },
    { type: "process_started", resumed: true, reason: "crash_recovery" },
    { type: "process_started", resumed: true, reason: "restart" },
    { type: "process_started", resumed: true, reason: "boot_resume" },
    { type: "process_started", resumed: false, reason: "message" },
    { type: "session_reset", by: "@or" },
    { type: "process_started", resumed: false, reason: "reset" },
    {
      type: "container",
      action: "created",
      image: "open-factory-base:dev",
      imageId: "sha256:1",
    },
    { type: "container", action: "recreated", image: "x", imageId: "sha256:2" },
    { type: "container", action: "started", image: "x", imageId: "sha256:2" },
    { type: "cleanup", killedProcesses: 2 },
    { type: "cleanup", killedProcesses: 1 },
    { type: "cleanup", container: "stopped" },
    { type: "stop_escalated", how: "sigkill" },
    {
      type: "background_work_lost",
      reason: "crash",
      tasks: [{ taskId: "t1", description: "pnpm test" }],
      crons: [{ cronId: "c1", humanSchedule: "Every 5 minutes" }],
    },
    { type: "reconciled", killedProcesses: 1, stoppedContainer: false },
    { type: "control", cmd: "restart", by: "@or" },
    { type: "exited", code: 137, signal: null, stderrTail: "boom", expected: false },
    { type: "exited", code: 0, signal: null, stderrTail: "", expected: true },
  ]);
  expect(texts).toEqual([
    "Hibernated after 70 minutes idle",
    "Hibernated to free a slot",
    "Hibernated to apply changes",
    "Hibernated: the server stopped",
    "Stopped: the agent was archived",
    "Woke up",
    "Resumed after a crash",
    "Restarted",
    "Resumed after the server restarted",
    "Started a new session",
    "New session started by @or. Earlier history stays above; the agent no longer remembers it.",
    "Container created (open-factory-base:dev)",
    "Container re-created: image or mounts changed",
    "Stopped 2 leftover processes",
    "Stopped 1 leftover process",
    "Stopped the container to clear leftover processes",
    "The process didn't stop in time, so it was killed",
    "Lost when the process stopped: pnpm test (background) · every 5 minutes (cron)",
    "Cleaned up after the server restarted",
    "Restarted by @or",
    // The exit code and stderr tail stay in the collapsed detail.
    "Stopped unexpectedly",
    "Stopped",
  ]);
  const crash = els[20] as HTMLElement;
  expect(crash.querySelector("details")).not.toBeNull();
  expect(crash.querySelector("details")?.open).toBe(false);
  expect(within(crash).getByText("Stopped unexpectedly")).toHaveClass("text-foreground");
  expect(crash.querySelector("svg:not(.lucide-chevron-right)")).toHaveClass("text-destructive");
  expect(within(els[11] as HTMLElement).getByText("open-factory-base:dev")).toHaveClass(
    "font-mono",
  );
});

test("timeline: the unexpected exit's detail carries the code and stderr", () => {
  const { els } = lines([
    { type: "exited", code: null, signal: "SIGKILL", stderrTail: "killed", expected: false },
  ]);
  const pre = (els[0] as HTMLElement).querySelector("pre");
  expect(pre?.textContent).toBe("Signal SIGKILL\nkilled");
});

test("timeline: a runtime error has no fix link but explains the gate in its Why popover", async () => {
  const { els } = lines([
    {
      type: "error",
      source: "spawn",
      message: "The local runtime is disabled on this factory.",
      fix: "runtime",
    },
  ]);
  const row = els[0] as HTMLElement;
  expect(row.querySelector("a")).toBeNull();
  vi.useRealTimers();
  await userEvent.click(
    within(row).getByRole("button", { name: "Why is the local runtime disabled?" }),
  );
  expect(await screen.findByText(/An operator has to allow unsandboxed agents/)).toHaveTextContent(
    "FACTORY_ALLOW_LOCAL_RUNTIME=true",
  );
});

test("timeline: a spawned agent's error never links to the edit page (it can't be edited)", () => {
  const err = (fix: "edit_agent" | "resync"): AnyEvent => ({
    type: "error",
    source: "spawn",
    message: `failed (${fix})`,
    fix,
  });
  const { els } = lines([err("edit_agent"), err("resync")], true);
  expect(els).toHaveLength(2);
  for (const el of els) expect(el.querySelector("a")).toBeNull();
});

test("timeline: mcp_unavailable is a warning quiet line with the status in its detail", () => {
  const { texts, els } = lines([{ type: "mcp_unavailable", status: "failed" }]);
  expect(texts).toEqual([
    "Factory tools didn't connect in this process, so it can't send messages until it restarts. Messages to it still arrive.",
  ]);
  const el = els[0] as HTMLElement;
  expect(el.querySelector("details")?.open).toBe(false);
  expect(el.querySelector("pre")?.textContent).toBe("failed");
  expect(el.querySelector("svg")).not.toBeNull();
  expect(el.querySelector("svg")).not.toHaveClass("text-destructive");
});

test("timeline: interrupt_unconfirmed is a warning quiet line", () => {
  const { texts, els } = lines([{ type: "interrupt_unconfirmed" }]);
  expect(texts).toEqual([
    "The turn didn't confirm the stop within 10 seconds, so held messages were sent anyway.",
  ]);
  const icon = (els[0] as HTMLElement).querySelector("svg");
  expect(icon).toHaveClass("lucide-triangle-alert");
  expect(icon).not.toHaveClass("text-destructive");
});

test("timeline: spawned-agent lifecycle lines without an agent link (human and TTL `by`)", () => {
  const { texts, els } = lines([
    { type: "process_started", resumed: false, reason: "spawned" },
    { type: "terminated", by: "@or" },
    { type: "terminated", by: "@factory" },
    {
      type: "background_work_lost",
      reason: "terminated",
      tasks: [{ taskId: "t1", description: "pnpm test" }],
      crons: [],
    },
    {
      type: "message_in",
      messages: [
        {
          id: "p1",
          from: "@factory",
          kind: "peer_left",
          urgent: false,
          about: "tech-lead-ab12",
          body: "IGNORED",
          subject: {
            slug: "tech-lead-ab12",
            displayName: "Tech Lead · ab12",
            relation: "peer",
            left: { reason: "terminated", by: "@or" },
          },
        },
        {
          id: "p2",
          from: "@factory",
          kind: "peer_left",
          urgent: false,
          about: "dev-cd34",
          body: "IGNORED",
          subject: {
            slug: "dev-cd34",
            displayName: "Dev · cd34",
            relation: "peer",
            left: { reason: "terminated", by: "@factory" },
          },
        },
      ],
    },
  ]);
  expect(texts).toEqual([
    "Terminated by @or",
    "Terminated after 3 days without activity",
    "Lost when it was terminated: pnpm test (background)",
    "@tech-lead-ab12 · Tech Lead · ab12 left: terminated by @or",
    "@dev-cd34 · Dev · cd34 left: terminated after 3 days without activity",
  ]);
  expect(within(els[0] as HTMLElement).getByText("@or")).toHaveClass("font-mono");
  expect(within(els[3] as HTMLElement).getByText("@or")).toHaveClass("font-mono");
  // The CircleX icon marks every "Terminated" line.
  expect(els[0]?.querySelector("svg.lucide-circle-x")).not.toBeNull();
  expect(els[1]?.querySelector("svg.lucide-circle-x")).not.toBeNull();
  expect(texts.join()).not.toContain("@factory");
});
