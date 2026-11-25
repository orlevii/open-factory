import { act, render, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type Activity, deriveActivity } from "./activity";
import { ActivityLine, TurnActivity, useFallbackHold } from "./activity-line";

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  setHidden(false);
  vi.useRealTimers();
});

const running: Activity = { kind: "tool", tool: "Bash", target: "pnpm test" };
const working: Activity = { kind: "working" };
function Held({ activity, turnKey }: { activity: Activity; turnKey: string }) {
  const shown = useFallbackHold(activity, turnKey);
  return <ActivityLine activity={shown} />;
}
/** Visible text: MiddleTruncate repeats its text for screen readers. */
const visible = (el: Element | null | undefined) => {
  const c = el?.cloneNode(true) as Element | undefined;
  for (const sr of c?.querySelectorAll(".sr-only") ?? []) sr.remove();
  return c?.textContent;
};
const label = () => visible(document.querySelector("[data-activity-label]"));

test("a change to Working holds the previous label 400 ms, never past the turn", () => {
  const { rerender } = render(<Held activity={running} turnKey="1" />);
  expect(label()).toBe("Running pnpm test");
  rerender(<Held activity={working} turnKey="1" />);
  expect(label()).toBe("Running pnpm test");
  act(() => vi.advanceTimersByTime(399));
  expect(label()).toBe("Running pnpm test");
  act(() => vi.advanceTimersByTime(1));
  expect(label()).toBe("Working");
  // Any other change is instant, and cuts a hold short.
  rerender(<Held activity={running} turnKey="1" />);
  expect(label()).toBe("Running pnpm test");
  rerender(<Held activity={working} turnKey="1" />);
  rerender(<Held activity={{ kind: "subagent", target: "Draft" }} turnKey="1" />);
  expect(label()).toBe("Subagent: Draft");
  // A new turn never inherits the previous turn's label.
  rerender(<Held activity={working} turnKey="2" />);
  expect(label()).toBe("Working");
  expect(vi.getTimerCount()).toBe(0);
});

test("labels: verbs per tool, subagents, MCP, the PR4 kinds and the fallback", () => {
  const cases: [Activity, string][] = [
    [{ kind: "tool", tool: "Bash", target: "pnpm test" }, "Running pnpm test"],
    [{ kind: "tool", tool: "Read", target: "retry.ts" }, "Reading retry.ts"],
    [{ kind: "tool", tool: "Edit", target: "retry.ts" }, "Editing retry.ts"],
    [{ kind: "tool", tool: "Write", target: "retry.ts" }, "Writing retry.ts"],
    [{ kind: "tool", tool: "Grep", target: "TODO" }, "Searching TODO"],
    [{ kind: "tool_input", tool: "Write", target: "src/app.ts" }, "Writing src/app.ts"],
    [
      { kind: "tool", tool: "mcp__github__create_pr", target: "github · create_pr" },
      "github · create_pr",
    ],
    [{ kind: "tool", tool: "WebFetch" }, "WebFetch"],
    [{ kind: "subagent", target: "Draft the request" }, "Subagent: Draft the request"],
    [{ kind: "subagents", target: "Three", more: 2 }, "Subagents: Three and 2 more"],
    [{ kind: "thinking" }, "Thinking"],
    [{ kind: "text" }, "Writing a reply"],
    [{ kind: "working" }, "Working"],
    [{ kind: "compacting" }, "Compacting"],
  ];
  for (const [activity, text] of cases) {
    const { unmount } = render(<ActivityLine activity={activity} />);
    expect(label()).toBe(text);
    expect(document.querySelector("[data-activity-label]")).toHaveAttribute("title", text);
    unmount();
  }
});

test("layout: tooth, duration first, then a truncating label", () => {
  vi.setSystemTime(new Date("2026-11-21T10:00:42.000Z"));
  render(<ActivityLine activity={running} startedAt="2026-11-21T10:00:00.000Z" />);
  const line = document.querySelector("[data-activity-line]") as HTMLElement;
  expect(visible(line)).toBe("42s · Running pnpm test");
  const [tooth, duration] = [...line.children] as HTMLElement[];
  expect(tooth).toHaveAttribute("aria-hidden", "true");
  expect(tooth?.querySelector(".of-tooth")).not.toBeNull();
  expect(duration).toHaveTextContent("42s");
  const lbl = line.querySelector("[data-activity-label]") as HTMLElement;
  expect(line.lastElementChild).toBe(lbl);
});

test("without a start time the duration is omitted", () => {
  render(<ActivityLine activity={working} />);
  expect(visible(document.querySelector("[data-activity-line]"))).toBe("Working");
});

test("while compacting the open turn's line reads Compacting", () => {
  render(<TurnActivity open={undefined} turnKey="1" compacting />);
  expect(label()).toBe("Compacting");
});

test("a command shows whole in one span, never split head and tail like a file path", () => {
  const cmd = "pnpm vitest run src/agents/agent-runtime.held.test.ts";
  render(<ActivityLine activity={{ kind: "tool", tool: "Bash", target: cmd }} />);
  // One visible span holding the whole command: no head/tail split around its last "/".
  const lbl = document.querySelector("[data-activity-label]") as HTMLElement;
  expect(within(lbl).getByText(cmd)).toBeInTheDocument();
});

test("a file tool's path middle-truncates", () => {
  render(<ActivityLine activity={{ kind: "tool_input", tool: "Write", target: "src/app.ts" }} />);
  const lbl = document.querySelector("[data-activity-label]") as HTMLElement;
  expect(within(lbl).getByText("/app.ts")).toBeInTheDocument(); // the tail kept apart from the head
});

test("an MCP label truncates its server first, as the tool row does", () => {
  render(
    <ActivityLine
      activity={{
        kind: "tool",
        tool: "mcp__github-cloud-connector__create_pr",
        target: "github-cloud-connector · create_pr",
      }}
    />,
  );
  const label = document.querySelector("[data-activity-label]") as HTMLElement;
  const server = label.querySelector("[data-mcp-server]") as HTMLElement;
  expect(server).toHaveTextContent(/^github-cloud-connector$/);
  expect(label.querySelector("[data-mcp-sep]")).toHaveTextContent("·");
  expect(label.querySelector("[data-mcp-tool]")).toHaveTextContent("create_pr");
});

test("a Bash call with a description reads as that description, in prose, with no 'Running' before it", () => {
  render(
    <ActivityLine
      activity={deriveActivity(
        {
          openSubagents: [],
          newestOpenTool: {
            kind: "tool",
            seq: 1,
            at: "2026-11-18T10:00:00.000Z",
            call: {
              type: "tool_call",
              toolUseId: "t",
              name: "Bash",
              input: { command: "pnpm test", description: "Run the tests" },
            },
            state: "running",
            children: [],
            key: "1",
          },
        },
        undefined,
      )}
    />,
  );
  const label = document.querySelector("[data-activity-label]") as HTMLElement;
  expect(label).toHaveTextContent(/^Run the tests$/);
});

type Live = NonNullable<Parameters<typeof TurnActivity>[0]["live"]>;
const writing = (bytes: number): Live => ({
  toolInput: { toolUseId: "tu1", name: "Write", target: "/w/src/app.ts", bytes },
  texts: [],
});
const counter = () => document.querySelector("[data-activity-count]")?.textContent;

test("live tool input: the open tool's label, with a KB counter that updates at most twice a second", () => {
  const view = render(<TurnActivity open={undefined} live={writing(12_400)} turnKey="1" />);
  expect(label()).toBe("Writing app.ts");
  expect(counter()).toBe("12 KB");
  const seen = new Set<string | undefined>([counter()]);
  // Frames every 50ms for a second: the counter moves at most twice.
  let changes = 0;
  for (let i = 1; i <= 20; i++) {
    view.rerender(<TurnActivity open={undefined} live={writing(12_400 + i * 1000)} turnKey="1" />);
    act(() => vi.advanceTimersByTime(50));
    const now = counter();
    if (!seen.has(now)) changes++;
    seen.add(now);
  }
  expect(changes).toBeGreaterThan(0);
  expect(changes).toBeLessThanOrEqual(2);
  // It settles on the latest figure.
  act(() => vi.advanceTimersByTime(500));
  expect(counter()).toBe("32 KB");
  // Not part of the label (the title keeps the label alone).
  expect(document.querySelector("[data-activity-label]")).toHaveAttribute(
    "title",
    "Writing app.ts",
  );
});

test("a new tool's input starts its own counter at once", () => {
  const view = render(<TurnActivity open={undefined} live={writing(40_000)} turnKey="1" />);
  expect(counter()).toBe("40 KB");
  view.rerender(
    <TurnActivity
      open={undefined}
      live={{
        toolInput: { toolUseId: "tu2", name: "Write", target: "b.md", bytes: 2000 },
        texts: [],
      }}
      turnKey="1"
    />,
  );
  expect(counter()).toBe("2 KB");
});

test("thinking shows only while live thinking is set; live text reads Writing a reply", () => {
  const view = render(
    <TurnActivity open={undefined} live={{ thinking: { tokens: 5 }, texts: [] }} turnKey="1" />,
  );
  expect(label()).toBe("Thinking");
  view.rerender(<TurnActivity open={undefined} live={{ texts: ["x"] }} turnKey="1" />);
  expect(label()).toBe("Writing a reply");
  expect(counter()).toBeUndefined();
});

test("a text block ending and the next tool starting within 400ms never shows Working", () => {
  const shown: string[] = [];
  const record = () => {
    const l = label();
    if (l !== undefined && shown.at(-1) !== l) shown.push(l);
  };
  const view = render(<TurnActivity open={undefined} live={{ texts: ["x"] }} turnKey="1" />);
  record();
  view.rerender(<TurnActivity open={undefined} live={{ texts: [] }} turnKey="1" />);
  record();
  act(() => vi.advanceTimersByTime(300));
  record();
  view.rerender(<TurnActivity open={undefined} live={writing(100)} turnKey="1" />);
  record();
  act(() => vi.advanceTimersByTime(1000));
  record();
  expect(shown).toEqual(["Writing a reply", "Writing app.ts"]);
});

test("the KB counter waits until there is at least 1 KB (never '0 KB')", () => {
  const view = render(<TurnActivity open={undefined} live={writing(400)} turnKey="1" />);
  expect(label()).toBe("Writing app.ts");
  expect(counter()).toBeUndefined();
  view.rerender(<TurnActivity open={undefined} live={writing(1200)} turnKey="1" />);
  expect(counter()).toBe("1 KB");
});
