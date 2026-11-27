import type { AnyEvent, SessionEvent, SubagentProgress } from "@open-factory/shared";
import { act, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { refFor } from "@/test/refs";
import { runDisplayPasses } from "./display-passes";
import { buildRows, type Row } from "./rows";
import { Timeline } from "./timeline";

let seq = 0;
const at = (n: number) => new Date(Date.UTC(2026, 10, 21, 10, 0, n)).toISOString();
const e = (event: AnyEvent): SessionEvent => {
  seq++;
  return { seq, agentRef: refFor("dev"), turnId: "t1", at: at(seq), event };
};
const call = (id: string, description = "Draft the request", subagentType?: string) =>
  e({
    type: "tool_call",
    toolUseId: id,
    name: "Agent",
    input: {
      description,
      prompt: "Write **the** request",
      ...(subagentType ? { subagent_type: subagentType } : {}),
    },
  });
const result = (id: string, content: string, meta?: Record<string, unknown>) =>
  e({
    type: "tool_result",
    toolUseId: id,
    content,
    isError: false,
    ...(meta ? { meta } : {}),
  } as AnyEvent);
const inside = (id: string, event: Record<string, unknown>) =>
  e({ ...event, parentToolUseId: id } as AnyEvent);

const rowsOf = (events: SessionEvent[]): Row[] => runDisplayPasses(buildRows(events).rows);

function show(rows: Row[], subagents: readonly SubagentProgress[] = []) {
  const props = {
    agentRef: refFor("dev"),
    failedIds: new Set<string>(),
    interruptedEnds: new Set<number>(),
    hasMoreBefore: false,
    onLoadEarlier: async () => false,
    earlierError: false,
    footer: null,
  };
  const view = render(<Timeline {...props} rows={rows} subagents={subagents} />);
  return {
    ...view,
    update: (r: Row[], s: readonly SubagentProgress[] = subagents) =>
      view.rerender(<Timeline {...props} rows={r} subagents={s} />),
  };
}
const header = (key: string) => document.querySelector<HTMLElement>(`[data-row="${key}"]`);
const card = (key: string) => header(key)?.closest("[data-subagent]") as HTMLElement;
const chip = (key: string) => card(key).querySelector("[data-subagent-chip]")?.textContent;
const progress = (over: Partial<SubagentProgress> = {}): SubagentProgress => ({
  toolUseId: "ag",
  description: "Draft the request",
  subagentType: "general-purpose",
  toolUses: 4,
  tokens: 123_000,
  durationMs: 9000,
  ...over,
});

beforeEach(() => {
  seq = 0;
});
afterEach(() => vi.useRealTimers());

test("header: Subagent · type · description and a Running chip with the tooth; named as in this session", () => {
  const rows = rowsOf([e({ type: "turn_started" }), call("ag")]);
  show(rows);
  const h = header("2") as HTMLElement;
  expect(h.textContent).toContain("Subagent");
  expect(h.textContent).toContain("general-purpose");
  expect(h.textContent).toContain("Draft the request");
  expect(h).toHaveAccessibleName(/Subagent in this session · general-purpose · Draft the request/);
  expect(chip("2")).toBe("Running");
  expect(card("2").querySelector("[data-subagent-chip] .of-tooth")).not.toBeNull();
  expect(card("2").querySelector("img, [data-avatar]")).toBeNull();
});

test("running: one live line from progress, counters first, updated at most twice a second", () => {
  vi.useFakeTimers();
  const events = [
    e({ type: "turn_started" }),
    call("ag"),
    inside("ag", {
      type: "tool_call",
      toolUseId: "r1",
      name: "Read",
      input: { file_path: "/w/templates/purchase.md" },
    }),
  ];
  const rows = rowsOf(events);
  const view = show(rows, [progress()]);
  const line = () => card("2").querySelector("[data-subagent-live]")?.textContent;
  expect(line()).toBe("4 tool calls · 123k tokens · Reading purchase.md");
  let changes = 0;
  let last = line();
  for (let i = 1; i <= 20; i++) {
    view.update(rows, [progress({ toolUses: 4 + i })]);
    act(() => vi.advanceTimersByTime(50));
    if (line() !== last) changes++;
    last = line();
  }
  expect(changes).toBeGreaterThan(0);
  expect(changes).toBeLessThanOrEqual(2);
  // Never a ticking timer.
  expect(line()).not.toMatch(/\d+s\b/);
});

test("the live line falls back to the last tool's name when no nested call is loaded", () => {
  const rows = rowsOf([e({ type: "turn_started" }), call("ag")]);
  show(rows, [progress({ toolUses: 1, tokens: 900, lastTool: "Bash" })]);
  expect(card("2").querySelector("[data-subagent-live]")?.textContent).toBe(
    "1 tool call · 900 tokens · Bash",
  );
});

test("collapsed by default; expanded the body reads prompt, then the folded transcript, then the result last", () => {
  const rows = rowsOf([
    e({ type: "turn_started" }),
    call("ag"),
    inside("ag", { type: "tool_call", toolUseId: "b1", name: "Bash", input: { command: "ls" } }),
    inside("ag", { type: "tool_result", toolUseId: "b1", content: "x", isError: false }),
    inside("ag", { type: "tool_call", toolUseId: "b2", name: "Bash", input: { command: "pwd" } }),
    inside("ag", { type: "tool_result", toolUseId: "b2", content: "y", isError: false }),
    result("ag", "The **result**"),
  ]);
  show(rows);
  expect(header("2")).toHaveAttribute("aria-expanded", "false");
  expect(card("2").textContent).not.toContain("Write the request");
  fireEvent.click(header("2") as HTMLElement);
  const body = card("2").querySelector("[data-row-body]") as HTMLElement;
  const text = body.textContent ?? "";
  const [p = -1, t = -1, r = -1] = ["Write the request", "Ran 2 commands", "The result"].map((s) =>
    text.indexOf(s),
  );
  expect(p).toBeGreaterThanOrEqual(0);
  expect(t).toBeGreaterThan(p);
  expect(r).toBeGreaterThan(t);
  // The transcript is folded (§9.4): one group row, not two calls.
  expect(within(body).getByText("Ran 2 commands", { exact: false })).toBeInTheDocument();
  expect(body.querySelector("strong")?.textContent).toBe("the");
});

test("done: Done, the result's first 3 lines without expanding, and figures from Agent meta", () => {
  const rows = rowsOf([
    e({ type: "turn_started" }),
    call("ag"),
    result("ag", "one\ntwo\nthree\nfour", {
      tool: "Agent",
      toolUses: 12,
      tokens: 23_456,
      durationMs: 41_000,
    }),
  ]);
  show(rows);
  expect(chip("2")).toBe("Done");
  const preview = card("2").querySelector("[data-subagent-preview]")?.textContent;
  expect(preview).toBe("one\ntwo\nthree");
  expect(card("2").querySelector("[data-subagent-footer]")?.textContent).toBe(
    "12 tool calls · 41s · 23.5k tokens",
  );
  expect(card("2").querySelector("[data-subagent-live]")).toBeNull();
});

test("no footer without meta or usage", () => {
  show(rowsOf([e({ type: "turn_started" }), call("ag"), result("ag", "fine")]));
  expect(card("2").querySelector("[data-subagent-footer]")).toBeNull();
});

test("async: In background with its live line until background_task_finished; the launch text never shows", () => {
  const launch = [
    e({ type: "turn_started" }),
    call("ag"),
    result("ag", "Async agent launched successfully", { tool: "Agent", async: true }),
    e({
      type: "background_task_started",
      taskId: "k1",
      toolUseId: "ag",
      taskType: "local_agent",
    } as AnyEvent),
  ];
  const view = show(rowsOf(launch), [progress()]);
  expect(chip("2")).toBe("In background");
  expect(card("2").querySelector("[data-subagent-live]")).not.toBeNull();
  expect(card("2").textContent).not.toContain("Async agent launched");
  fireEvent.click(header("2") as HTMLElement);
  expect(card("2").textContent).not.toContain("Async agent launched");
  const finished = [
    ...launch,
    e({
      type: "background_task_finished",
      taskId: "k1",
      status: "completed",
      summary: "Found 3 files",
      usage: { toolUses: 2, tokens: 500, durationMs: 3000 },
    } as AnyEvent),
  ];
  view.update(rowsOf(finished), []);
  expect(chip("2")).toBe("Done");
  expect(card("2").textContent).toContain("Found 3 files");
  expect(card("2").textContent).not.toContain("Async agent launched");
  expect(card("2").querySelector("[data-subagent-footer]")?.textContent).toBe(
    "2 tool calls · 3s · 500 tokens",
  );
});

test("an async subagent with a later exit and no finish reads Stopped, its live line gone", () => {
  const rows = rowsOf([
    e({ type: "turn_started" }),
    call("ag"),
    result("ag", "Async agent launched", { tool: "Agent", async: true }),
    e({ type: "exited", expected: true, code: 0, signal: null } as AnyEvent),
  ]);
  show(rows, []);
  expect(chip("2")).toBe("Stopped");
  expect(card("2").querySelector("[data-subagent-live]")).toBeNull();
});

test("five parallel subagents: three cards and +2 more subagents · 1 running below; cards never collapse", () => {
  const events = [
    e({ type: "turn_started" }),
    call("a1", "one"),
    call("a2", "two"),
    call("a3", "three"),
  ];
  const view = show(rowsOf(events));
  const firstCards = ["2", "3", "4"].map((k) => card(k));
  const more = [...events, call("a4", "four"), call("a5", "five"), result("a4", "ok")];
  view.update(rowsOf(more));
  ["2", "3", "4"].forEach((k, i) => {
    expect(card(k)).toBe(firstCards[i]);
  });
  const overflow = header("5") as HTMLElement;
  expect(overflow.textContent).toBe("+2 more subagents · 1 running");
  expect(overflow).toHaveAttribute("aria-expanded", "false");
  expect(header("6")).toBeNull();
  fireEvent.click(overflow);
  expect(card("c:5")).not.toBeNull();
  expect(card("6")).not.toBeNull();
  // The overflow row sits below the three cards.
  const keys = [...document.querySelectorAll("[data-row]")].map((n) => n.getAttribute("data-row"));
  expect(keys.indexOf("5")).toBeGreaterThan(keys.indexOf("4"));
});

test("a deep link into an overflowed card's transcript opens the overflow row and the card, and lands on the row", () => {
  const events = [
    e({ type: "turn_started" }),
    call("a1", "one"),
    call("a2", "two"),
    call("a3", "three"),
    call("a4", "four"),
    call("a5", "five"),
    inside("a5", { type: "assistant_text", text: "deep inside" }),
  ];
  render(
    <Timeline
      agentRef={refFor("dev")}
      rows={rowsOf(events)}
      highlightSeq={7}
      failedIds={new Set()}
      interruptedEnds={new Set()}
      hasMoreBefore={false}
      onLoadEarlier={async () => false}
      earlierError={false}
      footer={null}
    />,
  );
  expect(header("5")).toHaveAttribute("aria-expanded", "true");
  expect(header("6")).toHaveAttribute("aria-expanded", "true");
  expect(document.activeElement).toBe(header("7"));
  expect(header("7")?.textContent).toContain("deep inside");
});

test("the overflow header reads like the cards: named as in this session", () => {
  show(
    rowsOf([
      e({ type: "turn_started" }),
      call("a1"),
      call("a2"),
      call("a3"),
      call("a4"),
      call("a5"),
    ]),
  );
  const over = header("5") as HTMLElement;
  expect(over).toHaveAccessibleName("+2 more subagents in this session · 2 running");
});
