import type { AnyEvent, SessionEvent } from "@open-factory/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { longPress } from "@/test/long-press";
import { json, mockApi } from "@/test/mock-api";
import { agentSummary, resetSeq, se } from "@/test/session-fixtures";
import { groupWork, mergeFailures } from "./display-passes";
import { rowMenuItems } from "./row-menu";
import { buildRows, type Row } from "./rows";
import { buildSpeakerIndex, SpeakerContext } from "./speaker-line";
import { Timeline } from "./timeline";
import { TimelineRow } from "./timeline-row";
import { workGroupText } from "./work-group";

const notify = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toaster", () => ({ notify }));

const NOW = new Date(2026, 10, 19, 10, 0);
const todayAt = (h: number, m: number) => new Date(2026, 10, 19, h, m).toISOString();
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  resetSeq();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  notify.mockReset();
});

/** Renders the rows the events produce; returns each top-level row's text. */
function lines(events: AnyEvent[], spawned = false) {
  const { rows } = buildRows(events.map((e) => se(e, null)));
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

test("timeline: the resync fix runs the agent's Re-sync in place and toasts its outcome", async () => {
  const api = mockApi({
    "POST /api/agents/dev/resync": () => json({ agent: agentSummary(), applied: "on_restart" }),
  });
  const { rows } = buildRows([
    se({ type: "error", source: "spawn", message: "Re-sync @dev.", fix: "resync" }, null),
  ]);
  const row = rows[0] as Row;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TimelineRow
        slug="dev"
        row={row}
        expanded={new Set()}
        toggle={() => {}}
        rowProps={() => ({})}
        failedIds={new Set()}
        interruptedEnds={new Set()}
      />
    </QueryClientProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Re-sync the agent" }));
  await waitFor(() =>
    expect(notify).toHaveBeenCalledWith({
      text: "Re-synced. The changes apply when @dev restarts (when idle).",
    }),
  );
  expect(api.calls.map((c) => `${c.method} ${c.url}`)).toEqual(["POST /api/agents/dev/resync"]);
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

// Turn footer copy (U3 §5.3)
const footerLine = (over: Partial<Extract<import("./rows").Row, { kind: "turn_footer" }>> = {}) => {
  const { container } = render(
    <TimelineRow
      slug="dev"
      spawned={false}
      row={{ kind: "turn_footer", seq: 1, key: "1", durationMs: 4000, costUsd: 0, ...over }}
      expanded={new Set()}
      toggle={() => {}}
      rowProps={() => ({})}
      failedIds={new Set()}
      interruptedEnds={new Set()}
    />,
  );
  return container.textContent;
};
test("footer copy", () =>
  expect(footerLine({ durationMs: 133_000, toolCalls: 14, costUsd: 0.42 })).toBe(
    "Worked 2m 13s · 14 tool calls · $0.42 est.",
  ));
test("zero parts and sub-cent cost are omitted; singular tool call", () => {
  expect(footerLine({ toolCalls: 0, costUsd: 0.004 })).toBe("Worked 4s");
  expect(footerLine({ toolCalls: 1 })).toBe("Worked 4s · 1 tool call");
});
test("self-started turns say what woke the agent", () => {
  expect(footerLine({ durationMs: 12_000, origin: "task" })).toBe(
    "Woke for a background task · 12s",
  );
  expect(footerLine({ durationMs: 12_000, origin: "cron" })).toBe("Woke for a cron · 12s");
});

// Repeated failures (U3 §7.6): one row, the count and the last time.
test("a merged failure says how many times and when the last one was", () => {
  const err = (at: string): SessionEvent => ({
    ...se(
      { type: "error", source: "spawn", code: "image", message: "Image `playwright` isn't built" },
      null,
    ),
    at,
  });
  const today = mergeFailures(
    buildRows([err(todayAt(9, 0)), err(todayAt(9, 10)), err(todayAt(9, 32))]).rows,
  );
  // Monday 16 Nov, three days before NOW (Thursday 19 Nov).
  const monday = new Date(2026, 10, 16, 19, 32).toISOString();
  const earlier = mergeFailures(
    buildRows([err(new Date(2026, 10, 15, 10, 0).toISOString()), err(monday)]).rows,
  );
  const { container } = render(
    <div>
      {[...today, ...earlier].map((row) => (
        <div key={row.key} data-row>
          <TimelineRow
            slug="dev"
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
  const texts = [...container.querySelectorAll("[data-row]")].map(
    (el) => el.querySelector("p")?.textContent,
  );
  expect(texts).toEqual([
    "Image `playwright` isn't built · 3 times · last 09:32",
    "Image `playwright` isn't built · 2 times · last Mon 19:32",
  ]);
});

// Reading sizes (U3 §7.3): nothing in a session outranks the page title.
test("the agent's own text uses the demoted heading scale", () => {
  const { els } = lines([{ type: "assistant_text", text: "# Plan\n\nBody" }]);
  const prose = els[0]?.querySelector(".prose-of");
  expect(prose).toHaveClass("prose-of-detail");
});

test("the log clips sideways overflow; the scroller around it does not", () => {
  render(
    <Timeline
      slug="dev"
      rows={[]}
      failedIds={new Set()}
      interruptedEnds={new Set()}
      hasMoreBefore={false}
      onLoadEarlier={async () => false}
      earlierError={false}
      footer={null}
    />,
  );
  const log = screen.getByRole("log");
  expect(log).toHaveClass("overflow-x-clip");
  expect(log.parentElement).not.toHaveClass("overflow-x-clip");
});

// ---- Speaker lines and spacing (U3 §7.1, §7.2) ----
const speakers = buildSpeakerIndex({
  sessionAgent: {
    slug: "dev",
    displayName: "Developer",
    template: "dev",
    kind: "persistent",
    avatarVersion: null,
  },
  selfHandle: "alice",
  live: [],
  ended: [],
});
const usage: AnyEvent = {
  type: "usage",
  model: "m",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  durationMs: 2000,
  numTurns: 1,
};
const turnEvents: AnyEvent[] = [
  { type: "turn_started" },
  { type: "assistant_text", text: "first" },
  { type: "assistant_text", text: "second" },
  {
    type: "message_in",
    messages: [{ id: "m1", from: "@or", kind: "message", body: "a question", urgent: false }],
  } as AnyEvent,
  { type: "assistant_text", text: "third" },
  usage,
  { type: "turn_end", isError: false, terminalReason: "completed", numTurns: 1 },
  { type: "turn_started" },
  { type: "assistant_text", text: "next turn" },
];

test("agent text shows the session agent's speaker line only on head rows, its body dir=auto", () => {
  const { rows } = buildRows(turnEvents.map((e) => se(e)));
  render(
    <SpeakerContext value={speakers}>
      {rows.map((row) => (
        <div key={row.key} data-test-row={row.key}>
          <TimelineRow
            slug="dev"
            row={row}
            expanded={new Set()}
            toggle={() => {}}
            rowProps={() => ({})}
            failedIds={new Set()}
            interruptedEnds={new Set()}
          />
        </div>
      ))}
    </SpeakerContext>,
  );
  const textRow = (t: string) => screen.getByText(t).closest("[data-test-row]") as HTMLElement;
  const speaks = (t: string) => textRow(t).querySelector("[data-speaker-line]") !== null;
  expect(speaks("first")).toBe(true);
  expect(speaks("second")).toBe(false);
  expect(speaks("third")).toBe(true);
  expect(speaks("next turn")).toBe(true);
  expect(within(textRow("first")).getByText("Developer")).toBeInTheDocument();
  // The session's own agent: never a link.
  expect(within(textRow("first")).queryByRole("link")).toBeNull();
  expect(screen.getByText("first").closest("[dir=auto]")).not.toBeNull();
});

test("spacing: 24px before a speaker line or card and after a turn footer, 8px inside a turn", () => {
  const { rows } = buildRows(turnEvents.map((e) => se(e)));
  render(
    <SpeakerContext value={speakers}>
      <Timeline
        slug="dev"
        rows={rows}
        failedIds={new Set()}
        interruptedEnds={new Set()}
        hasMoreBefore={false}
        onLoadEarlier={async () => false}
        earlierError={false}
        footer={null}
      />
    </SpeakerContext>,
  );
  const log = screen.getByRole("log");
  expect(log).not.toHaveClass("space-y-3");
  const gap = (t: string) => {
    const wrap = screen.getByText(t).closest("[data-row-wrap]") as HTMLElement;
    return ["mt-6", "mt-2"].filter((c) => wrap.classList.contains(c));
  };
  expect(gap("second")).toEqual(["mt-2"]);
  expect(gap("a question")).toEqual(["mt-6"]); // a card
  expect(gap("third")).toEqual(["mt-6"]); // a speaker line after the message
  expect(gap("next turn")).toEqual(["mt-6"]); // after the footer, and a head
  const footer = screen.getByText(/^Worked/).closest("[data-row-wrap]") as HTMLElement;
  expect(footer).toHaveClass("mt-2");
  // The first row has nothing above it.
  const first = screen.getByText("first").closest("[data-row-wrap]") as HTMLElement;
  expect(first.className).not.toMatch(/\bmt-/);
});

/** One tool call and its result, rendered expanded or not. */
function toolLine(name: string, input: unknown, content?: string, open = false) {
  const events: AnyEvent[] = [{ type: "tool_call", toolUseId: "tu1", name, input }];
  if (content !== undefined)
    events.push({ type: "tool_result", toolUseId: "tu1", content, isError: false });
  const row = buildRows(events.map((e) => se(e, null))).rows[0];
  if (!row) throw new Error("no row");
  // As in the timeline: `data-row` comes from rowProps, on the row's own box.
  return render(
    <div>
      <TimelineRow
        slug="dev"
        row={row}
        expanded={new Set(open ? [row.key] : [])}
        toggle={() => {}}
        rowProps={(r) => ({ "data-row": r.key })}
        failedIds={new Set()}
        interruptedEnds={new Set()}
      />
    </div>,
  );
}

test("an unknown tool keeps today's row: its name, the first string, and input and result plates", () => {
  toolLine("NotebookEdit", { notebook_path: "a.ipynb", cell: 3 }, "edited", true);
  const row = screen.getByRole("button", { expanded: true });
  expect(within(row).getByText("NotebookEdit")).toHaveClass("font-mono");
  expect(row).toHaveTextContent("a.ipynb");
  const plates = [...document.querySelectorAll("pre")].map((p) => p.textContent);
  expect(plates).toEqual([
    JSON.stringify({ notebook_path: "a.ipynb", cell: 3 }, null, 2),
    "edited",
  ]);
});

test("a 55-character MCP tool name truncates, with the full name in its title", () => {
  const name = "mcp__a_long_server_name_here__create_pull_request_now_x";
  expect(name).toHaveLength(55);
  toolLine(name, { title: "Fix" });
  const row = screen.getByRole("button", { expanded: false });
  const label = row.querySelector(`[title="${name}"]`);
  expect(label).not.toBeNull();
  // Not capped at 60%: the argument gives way first (it takes only the room the name leaves).
  expect(label).toHaveClass("min-w-0");
  expect(label).toHaveTextContent("a_long_server_name_here · create_pull_request_now_x");
  // The server middle-truncates: its head carries the ellipsis (mcp-name.test.tsx has the detail).
  expect(label?.querySelector("[data-mcp-server]")?.firstElementChild).toHaveClass("truncate");
  expect(row).toHaveTextContent("Fix");
});

// Folded tool runs (U3 §9.4).
type ToolR = Extract<Row, { kind: "tool" }>;
type Group = Extract<Row, { kind: "work_group" }>;
const t0 = Date.parse("2026-11-19T09:00:00.000Z");
const isoAt = (s: number) => new Date(t0 + s * 1000).toISOString();
const call = (seq: number, name: string, input: unknown, over: Partial<ToolR> = {}): ToolR => ({
  kind: "tool",
  seq,
  at: isoAt(seq),
  resultAt: isoAt(seq + 1),
  call: { type: "tool_call", toolUseId: `tu${seq}`, name, input },
  state: "done",
  children: [],
  key: `${seq}`,
  ...over,
});
const sh = (seq: number, over: Partial<ToolR> = {}) =>
  call(seq, "Bash", { command: `cmd ${seq}` }, over);
const rd = (seq: number) => call(seq, "Read", { file_path: `f${seq}.ts` });

function timeline(rows: Row[], extra: Partial<Parameters<typeof Timeline>[0]> = {}) {
  const props = {
    slug: "dev",
    failedIds: new Set<string>(),
    interruptedEnds: new Set<number>(),
    hasMoreBefore: false,
    onLoadEarlier: async () => false,
    earlierError: false,
    footer: null,
    ...extra,
  };
  const view = render(<Timeline {...props} rows={rows} />);
  return { ...view, update: (next: Row[]) => view.rerender(<Timeline {...props} rows={next} />) };
}
const rowEl = (key: string) => document.querySelector<HTMLElement>(`[data-row="${key}"]`);

test("final copy: 'Read 6 files, ran 4 commands · 1m 40s'", () => {
  const reads = [1, 2, 3, 4, 5, 6].map(rd);
  const cmds = [7, 8, 9, 10].map((s) => sh(s, s === 10 ? { resultAt: isoAt(101) } : {}));
  const [g] = groupWork([
    ...reads,
    ...cmds,
    { kind: "turn_footer", seq: 11, key: "11", durationMs: 1, costUsd: 0 },
  ]);
  expect(workGroupText(g as Group)).toBe("Read 6 files, ran 4 commands · 1m 40s");
  const [one] = groupWork([
    call(1, "Edit", { file_path: "a" }),
    call(2, "Grep", { pattern: "x" }),
    { kind: "turn_footer", seq: 3, key: "3", durationMs: 1, costUsd: 0 },
  ]);
  expect(workGroupText(one as Group)).toBe("Edited 1 file, 1 other call · 2s");
});

test("live header says '4 calls so far'", () => {
  const [g] = groupWork([sh(1), rd(2), sh(3), sh(4, { state: "running", resultAt: undefined })]);
  expect(workGroupText(g as Group)).toBe("4 calls so far");
  timeline([g as Row]);
  expect(rowEl("1")?.textContent).toBe("4 calls so far");
  expect(rowEl("1")).toHaveAttribute("aria-expanded", "false");
});

test("a single call stays a plain row; growing to two keeps the wrapper (no remount, no fade)", () => {
  const first = sh(3);
  const view = timeline([first], { liveAfter: 0 });
  const wrap = rowEl("3")?.closest("[data-row-wrap]");
  expect(wrap).not.toBeNull();
  view.update(groupWork([first, sh(5)]));
  expect(rowEl("3")?.closest("[data-row-wrap]")).toBe(wrap);
  expect(document.querySelectorAll("[data-row-wrap]")).toHaveLength(1);
  // The children stay unmounted until the group opens.
  expect(rowEl("c:3")).toBeNull();
  expect(rowEl("5")).toBeNull();
});

test("the group opens and closes; closing collapses its children, reopening leaves them collapsed", async () => {
  vi.useRealTimers();
  const user = userEvent.setup();
  timeline(groupWork([sh(3), sh(5)]));
  await user.click(rowEl("3") as HTMLElement);
  expect(rowEl("3")).toHaveAttribute("aria-expanded", "true");
  await user.click(rowEl("5") as HTMLElement);
  expect(rowEl("5")).toHaveAttribute("aria-expanded", "true");
  await user.click(rowEl("3") as HTMLElement);
  expect(rowEl("3")).toHaveAttribute("aria-expanded", "false");
  expect(rowEl("5")).toBeNull();
  await user.click(rowEl("3") as HTMLElement);
  expect(rowEl("5")).toHaveAttribute("aria-expanded", "false");
});

test("an expanded child opens its new group; focus on a child moves to the header", async () => {
  vi.useRealTimers();
  const user = userEvent.setup();
  // The first call, expanded and focused, becomes the group's first child.
  const first = sh(3);
  const view = timeline([first]);
  await user.click(rowEl("3") as HTMLElement);
  expect(rowEl("3")).toHaveFocus();
  view.update(groupWork([first, sh(5)]));
  expect(rowEl("3")).toHaveAttribute("aria-expanded", "true");
  expect(rowEl("c:3")).toHaveAttribute("aria-expanded", "true");
  expect(rowEl("3")).toHaveFocus();
  view.unmount();
  // A later call (a page of earlier rows lands before it) joins a group keyed by another row.
  const later = sh(5);
  const v2 = timeline([later]);
  await user.click(rowEl("5") as HTMLElement);
  v2.update(groupWork([sh(3), later]));
  expect(rowEl("3")).toHaveAttribute("aria-expanded", "true");
  expect(rowEl("5")).toHaveAttribute("aria-expanded", "true");
  expect(rowEl("3")).toHaveFocus();
  expect(rowEl("3")).toHaveAttribute("tabindex", "0");
});

test("a deep link into a group expands it and lands on the child", async () => {
  vi.useRealTimers();
  timeline(groupWork([sh(3), sh(5), sh(7)]), { highlightSeq: 5 });
  await waitFor(() => expect(rowEl("5")).not.toBeNull());
  expect(rowEl("3")).toHaveAttribute("aria-expanded", "true");
  expect(rowEl("5")).toHaveFocus();
});

// ---- Commands (U3 §13.3) ----

function renderRows(events: AnyEvent[]) {
  const { rows } = buildRows(events.map((e) => se(e)));
  render(
    <SpeakerContext value={speakers}>
      {rows.map((row) => (
        <div key={row.key} data-test-row={row.kind}>
          <TimelineRow
            slug="dev"
            row={row}
            expanded={new Set()}
            toggle={() => {}}
            rowProps={() => ({})}
            failedIds={new Set()}
            interruptedEnds={new Set()}
          />
        </div>
      ))}
    </SpeakerContext>,
  );
  return rows;
}

test("a command renders like your message: the command in mono and 'ran a command'", () => {
  const rows = renderRows([
    { type: "control", cmd: "command", arg: "/code-review src/", by: "@alice" },
  ]);
  expect(rows.map((r) => r.kind)).toEqual(["command"]);
  const row = document.querySelector("[data-test-row=command]") as HTMLElement;
  expect(within(row).getByText("You")).toBeInTheDocument();
  expect(within(row).getByText("ran a command")).toBeInTheDocument();
  expect(within(row).getByText("/code-review src/")).toHaveClass("font-mono");
  expect(row.querySelector("[data-message-block]")).not.toBeNull();
});

test("/context output renders as markdown with Copy", async () => {
  renderRows([
    {
      type: "command_output",
      command: "context",
      text: "## Context usage\n\n| Category | Tokens |\n| --- | --- |\n| System | 3k |",
    },
  ]);
  const row = document.querySelector("[data-test-row=command_output]") as HTMLElement;
  expect(within(row).getByRole("heading", { name: "Context usage" })).toBeInTheDocument();
  expect(within(row).getByRole("table")).toBeInTheDocument();
  expect(within(row).getByRole("button", { name: "Copy" })).toBeInTheDocument();
});

test("/usage and /cost output render as a code plate with Copy", () => {
  renderRows([
    { type: "command_output", command: "usage", text: "Total cost: $0.42\n## not a heading" },
    { type: "command_output", command: "cost", text: "Total cost: $0.10" },
  ]);
  const rows = [...document.querySelectorAll<HTMLElement>("[data-test-row=command_output]")];
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row.querySelector("pre")).not.toBeNull();
    expect(within(row).queryByRole("heading")).toBeNull();
    expect(within(row).getByRole("button", { name: "Copy" })).toBeInTheDocument();
  }
  expect(rows[0]?.querySelector("pre")?.textContent).toBe("Total cost: $0.42\n## not a heading");
});

test("the row menu copies a command and its output", () => {
  const rows = buildRows(
    [
      { type: "control", cmd: "command", arg: "/context", by: "@alice" } as AnyEvent,
      { type: "command_output", command: "context", text: "ctx" } as AnyEvent,
    ].map((e) => se(e)),
  ).rows;
  const copies = rows.map((r) =>
    rowMenuItems(r, "dev")
      .filter((i) => i.kind === "copy" && i.label !== "Copy link")
      .map((i) => (i.kind === "copy" ? [i.label, i.text] : [])),
  );
  expect(copies).toEqual([[["Copy command", "/context"]], [["Copy text", "ctx"]]]);
});

test("/context output is untrusted markdown: a mermaid fence shows as code", () => {
  renderRows([
    { type: "command_output", command: "context", text: "```mermaid\ngraph TD; A-->B\n```" },
  ]);
  const row = document.querySelector("[data-test-row=command_output]") as HTMLElement;
  expect(row.querySelector(".md-diagram")).toBeNull();
  expect(row.querySelector("pre")?.textContent).toContain("graph TD");
  // Shown as code (the plain code block with its own Copy), never handed to mermaid.
  expect(within(row).getAllByRole("button", { name: "Copy" })).toHaveLength(2);
});

// ---- Long-press on touch (U4 §11.2) ----

const pressEvents: AnyEvent[] = [
  { type: "turn_started" },
  { type: "assistant_text", text: "first" },
  { type: "assistant_text", text: "second" },
  {
    type: "message_in",
    messages: [{ id: "m1", from: "@or", kind: "message", body: "a question", urgent: false }],
  } as AnyEvent,
];
function pressTimeline(extra: Row[] = []) {
  vi.useRealTimers();
  const { rows } = buildRows(pressEvents.map((e) => se(e)));
  render(
    <SpeakerContext value={speakers}>
      <Timeline
        slug="dev"
        rows={[...rows, ...extra]}
        failedIds={new Set()}
        interruptedEnds={new Set()}
        hasMoreBefore={false}
        onLoadEarlier={async () => false}
        earlierError={false}
        footer={null}
      />
    </SpeakerContext>,
  );
  const card = screen.getByText("a question").closest<HTMLElement>("[data-message-block]");
  if (!card) throw new Error("no message card");
  return { rows, card, wrap: card.closest<HTMLElement>("[data-row-wrap]") as HTMLElement };
}

test("touch: a press on a message's speaker line opens its row menu; the card takes the pressed fill", async () => {
  const { card, wrap } = pressTimeline();
  const speaker = card.querySelector<HTMLElement>("[data-speaker-line]") as HTMLElement;
  expect(speaker).toHaveAttribute("data-longpress-region");
  longPress(speaker, { hold: 80, release: false });
  expect(card).toHaveAttribute("data-pressed");
  expect(wrap).not.toHaveAttribute("data-pressed");
  expect(speaker).not.toHaveAttribute("data-pressed");
  fireEvent.pointerCancel(speaker, { pointerType: "touch", pointerId: 1 });
  expect(card).not.toHaveAttribute("data-pressed");
  longPress(speaker, { x: 50, y: 90 });
  expect(await screen.findByRole("menu", { name: /^Message from @or/ })).toBeInTheDocument();
  expect(document.querySelector<HTMLElement>("[data-menu-stand-in].size-0")?.style.left).toBe(
    "50px",
  );
});

test("touch: a press on a tool row's summary line opens that row's menu, and never toggles it", async () => {
  pressTimeline([sh(9)]);
  const summary = rowEl("9") as HTMLElement;
  expect(summary).toHaveAttribute("data-longpress-region");
  longPress(summary);
  expect(await screen.findByRole("menu", { name: /^Bash/ })).toBeInTheDocument();
  expect(summary).toHaveAttribute("aria-expanded", "false");
});

test("touch: a press in a row's gutter opens its menu; the row, not the gutter, takes the fill", async () => {
  pressTimeline();
  const row = screen.getByText("second").closest<HTMLElement>("[data-row]") as HTMLElement;
  const wrap = row.closest<HTMLElement>("[data-row-wrap]") as HTMLElement;
  const gutter = wrap.querySelector<HTMLElement>(":scope > [data-row-gutter]") as HTMLElement;
  expect(gutter).toHaveAttribute("data-longpress-region");
  longPress(gutter, { hold: 80, release: false });
  expect(row).toHaveAttribute("data-pressed");
  expect(gutter).not.toHaveAttribute("data-pressed");
  fireEvent.pointerCancel(gutter, { pointerType: "touch", pointerId: 1 });
  longPress(gutter);
  expect(await screen.findByRole("menu", { name: /^@dev/ })).toBeInTheDocument();
});

test("prose is never a long-press region: a press on message text does nothing", () => {
  const { card } = pressTimeline();
  const prose = card.querySelector<HTMLElement>(".prose-of") as HTMLElement;
  expect(prose).not.toBeNull();
  for (const p of document.querySelectorAll(".prose-of")) {
    expect(p.closest("[data-longpress-region]")).toBeNull();
    expect(p.querySelector("[data-longpress-region]")).toBeNull();
  }
  longPress(prose.firstElementChild ?? prose, { hold: 700, release: false });
  expect(card).not.toHaveAttribute("data-pressed");
  expect(screen.queryByRole("menu")).toBeNull();
});

test("a mouse press on a speaker line does nothing", () => {
  const { card } = pressTimeline();
  const speaker = card.querySelector<HTMLElement>("[data-speaker-line]") as HTMLElement;
  longPress(speaker, { pointerType: "mouse", hold: 700, release: false });
  expect(card).not.toHaveAttribute("data-pressed");
  expect(screen.queryByRole("menu")).toBeNull();
});

test("the gutter strip comes first in its box, so a nested row's ⋯ and gutter paint and hit-test over it", async () => {
  vi.useRealTimers();
  const user = userEvent.setup();
  timeline(groupWork([sh(3), sh(5)]));
  await user.click(rowEl("3") as HTMLElement);
  const wrap = rowEl("3")?.closest<HTMLElement>("[data-row-wrap]") as HTMLElement;
  const calls = [...wrap.querySelectorAll<HTMLElement>("[data-call]")];
  expect(calls.length).toBe(2);
  // Positioned boxes without a z-index paint in tree order: the strip must precede the nested rows.
  expect(wrap.firstElementChild).toHaveAttribute("data-row-gutter");
  for (const c of calls) expect(c.firstElementChild).toHaveAttribute("data-row-gutter");
  // Touch only: a fine pointer never has it in the way.
  expect(wrap.firstElementChild).toHaveClass("hidden", "pointer-coarse:block");
});

test("touch: a press on a nested call's summary or gutter opens that call's menu only, and fills only it", async () => {
  vi.useRealTimers();
  const user = userEvent.setup();
  timeline(groupWork([sh(3), sh(5)]));
  await user.click(rowEl("3") as HTMLElement);
  const header = rowEl("3") as HTMLElement;
  const nested = rowEl("5") as HTMLElement;
  longPress(nested, { hold: 80, release: false });
  expect(nested).toHaveAttribute("data-pressed");
  expect(header).not.toHaveAttribute("data-pressed");
  fireEvent.pointerCancel(nested, { pointerType: "touch", pointerId: 1 });
  longPress(nested);
  await screen.findByRole("menu");
  expect(screen.getAllByRole("menu")).toHaveLength(1);
  expect(nested.closest("[data-call]")?.querySelector("[data-row-menu]")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(
    header.closest("[data-row-wrap]")?.querySelector(":scope > [data-row-menu]"),
  ).not.toHaveAttribute("aria-expanded", "true");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  const gutter = nested
    .closest("[data-call]")
    ?.querySelector<HTMLElement>(":scope > [data-row-gutter]") as HTMLElement;
  longPress(gutter, { hold: 80, release: false });
  expect(nested).toHaveAttribute("data-pressed");
  expect(header).not.toHaveAttribute("data-pressed");
  fireEvent.pointerCancel(gutter, { pointerType: "touch", pointerId: 1 });
});

test("chrome outside a timeline row (no menu there) is not a long-press region", () => {
  vi.useRealTimers();
  const { rows } = buildRows(pressEvents.map((e) => se(e)));
  render(
    <SpeakerContext value={speakers}>
      {rows.map((row) => (
        <TimelineRow
          key={row.key}
          slug="dev"
          row={row}
          expanded={new Set()}
          toggle={() => {}}
          rowProps={() => ({})}
          failedIds={new Set()}
          interruptedEnds={new Set()}
        />
      ))}
    </SpeakerContext>,
  );
  expect(document.querySelector("[data-speaker-line]")).not.toBeNull();
  expect(document.querySelector("[data-longpress-region]")).toBeNull();
});
