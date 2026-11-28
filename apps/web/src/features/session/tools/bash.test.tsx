import type { AnyEvent, ToolMeta } from "@open-factory/shared";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, expect, test } from "vitest";
import { resetSeq, se } from "@/test/session-fixtures";
import { buildRows, type ToolRow } from "../rows";
import { ToolCallRow } from "../tool-call-row";

beforeEach(() => resetSeq());

/** One Bash call (and its result when `content` is given) as the timeline builds it. */
function bashRow(
  input: Record<string, unknown>,
  result?: { content: string; isError?: boolean; meta?: ToolMeta },
): ToolRow {
  const events: AnyEvent[] = [{ type: "tool_call", toolUseId: "tu1", name: "Bash", input }];
  if (result)
    events.push({
      type: "tool_result",
      toolUseId: "tu1",
      content: result.content,
      isError: result.isError ?? false,
      ...(result.meta ? { meta: result.meta } : {}),
    });
  const row = buildRows(events.map((e) => se(e))).rows[0];
  if (row?.kind !== "tool") throw new Error("no tool row");
  return row;
}

function Harness({ row, open = false }: { row: ToolRow; open?: boolean }) {
  const [expanded, setExpanded] = useState(open);
  return (
    // As in the timeline: `data-row` is on the row's own button, the body is its sibling.
    <div>
      <ToolCallRow
        row={row}
        expanded={expanded}
        onToggle={() => setExpanded((x) => !x)}
        rowProps={{ "data-row": row.key }}
      />
    </div>
  );
}

const toggle = () => screen.getByRole("button", { expanded: false });

test("collapsed: the description, then the command on the same line; a one-word chip", () => {
  render(<Harness row={bashRow({ command: "pnpm test --run", description: "Run the tests" })} />);
  const row = toggle();
  expect(row).toHaveTextContent(/^Run the testspnpm test --runRunning$/);
});

test("collapsed without a description: $ command", () => {
  render(<Harness row={bashRow({ command: "ls -la" }, { content: "a" })} />);
  expect(toggle()).toHaveTextContent(/^\$ ls -la$/);
});

test("interrupted: the chip says so", () => {
  render(
    <Harness
      row={bashRow(
        { command: "sleep 99" },
        { content: "", isError: true, meta: { tool: "Bash", interrupted: true } },
      )}
    />,
  );
  expect(within(toggle()).getByText("Interrupted")).toBeInTheDocument();
});

test("failed: an icon and the first error line on a detail line under the collapsed row", () => {
  const { container } = render(
    <Harness
      row={bashRow(
        { command: "pnpm build" },
        { content: "\nError: cannot find module 'x'\n  at y", isError: true },
      )}
    />,
  );
  expect(within(toggle()).getByText("Failed")).toBeInTheDocument();
  const detail = screen.getByText("Error: cannot find module 'x'");
  expect(toggle()).not.toContainElement(detail);
  expect(detail.closest("p")?.querySelector("svg")).not.toBeNull();
  expect(container).not.toHaveTextContent("at y");
});

test("expanded: the last 12 lines, ANSI stripped, then Show all N lines in place", async () => {
  const out = Array.from({ length: 30 }, (_, i) => `\u001b[32mline ${i}\u001b[0m`).join("\n");
  render(<Harness open row={bashRow({ command: "seq 30" }, { content: out })} />);
  const plate = screen.getByText(/line 29/);
  expect(plate.textContent).toBe(Array.from({ length: 12 }, (_, i) => `line ${i + 18}`).join("\n"));
  const all = screen.getByRole("button", { name: "Show all 30 lines" });
  expect(all).toHaveAttribute("data-expands");
  await userEvent.click(all);
  expect(screen.getByText(/line 29/).textContent).toMatch(/^line 0\n/);
  expect(screen.queryByRole("button", { name: /Show all/ })).not.toBeInTheDocument();
});

test("expanded: binary output reads Binary output · 14 KB · show raw", async () => {
  const content = "\u0000".repeat(14_000);
  render(<Harness open row={bashRow({ command: "cat x.png" }, { content })} />);
  const line = screen.getByText(/^Binary output/).closest("p");
  // Exact text: the size's no-break space must survive (toHaveTextContent folds it to a space).
  expect(line?.textContent).toBe("Binary output · 14\u00a0KB · show raw");
  await userEvent.click(screen.getByRole("button", { name: "show raw" }));
  // Raw means unstripped, in the capped plate.
  expect(document.querySelector("pre")?.textContent).toBe(content);
});

test("expanded: stderr that ends the content gets its own plate with a label", () => {
  render(
    <Harness
      open
      row={bashRow(
        { command: "make" },
        {
          content: "built a\nbuilt b\nwarning: deprecated",
          meta: { tool: "Bash", interrupted: false, stderr: "warning: deprecated" },
        },
      )}
    />,
  );
  const out = screen.getByText(/built b/);
  expect(out.textContent).toBe("built a\nbuilt b");
  const err = screen.getByText("warning: deprecated");
  expect(err).not.toBe(out);
  expect(screen.getByRole("group", { name: "stderr" })).toHaveTextContent("warning: deprecated");
});

test("expanded: stderr that does not end the content stays in the output", () => {
  render(
    <Harness
      open
      row={bashRow(
        { command: "make" },
        {
          content: "a\nb",
          meta: { tool: "Bash", interrupted: false, stderr: "elsewhere" },
        },
      )}
    />,
  );
  expect([...document.querySelectorAll("pre")].map((p) => p.textContent)).toEqual(["a\nb"]);
  expect(screen.queryByText("stderr")).not.toBeInTheDocument();
});

test("expanded: output is text, never HTML", () => {
  render(<Harness open row={bashRow({ command: "cat a.html" }, { content: "<b>bold</b>" })} />);
  expect(screen.getByText("<b>bold</b>")).toBeInTheDocument();
  expect(document.querySelector("b")).toBeNull();
});

test("expanded while running: the command, since there is no output yet", () => {
  render(<Harness open row={bashRow({ command: "pnpm i" })} />);
  expect(document.querySelector("pre")).toHaveTextContent(/^\$ pnpm i$/);
});

test("expanded: a long or multi-line command is one Show input away", async () => {
  const command = "for f in *.ts; do\n  echo $f\ndone";
  render(<Harness open row={bashRow({ command }, { content: "a.ts" })} />);
  const show = screen.getByRole("button", { name: "Show input" });
  await userEvent.click(show);
  expect([...document.querySelectorAll("pre")].map((p) => p.textContent)).toEqual([
    "a.ts",
    `$ ${command}`,
  ]);
});

test("expanded: a short command adds nothing, so there is no Show input", () => {
  render(<Harness open row={bashRow({ command: "ls" }, { content: "a" })} />);
  expect(screen.queryByRole("button", { name: "Show input" })).not.toBeInTheDocument();
});

test("a failed call with a 64 KB single-line error renders its detail line without stalling", () => {
  const row = bashRow(
    { command: "node x" },
    { content: `Error: ${"y".repeat(65536)}\r`, isError: true },
  );
  const t = performance.now();
  render(<Harness row={row} />);
  expect(performance.now() - t).toBeLessThan(500);
  expect(screen.getByText(/^Error: y+$/)).toBeInTheDocument();
});

test("Show input is a disclosure button: aria-expanded flips when it is clicked", async () => {
  render(<Harness open row={bashRow({ command: "a\nb" }, { content: "x" })} />);
  const button = screen.getByRole("button", { name: "Show input" });
  expect(button).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(button);
  expect(screen.getByRole("button", { name: /Show input|Hide input/ })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
});

const withTask = (task: NonNullable<ToolRow["backgroundTask"]>): ToolRow => ({
  ...bashRow({ command: "make watch" }, { content: "Running in background" }),
  backgroundTask: task,
});

test("a background task: 'In background' on the call row's chip, no detail yet", () => {
  render(<Harness row={withTask({ taskId: "b", state: "running" })} />);
  expect(toggle()).toHaveTextContent(/^\$ make watchIn background$/);
  expect(screen.queryByText("Build ok")).toBeNull();
});

test("a finished or failed background task: the chip, and the summary on the detail line", () => {
  const { unmount } = render(
    <Harness row={withTask({ taskId: "b", state: "finished", summary: "Build ok" })} />,
  );
  expect(within(toggle()).getByText("Finished")).toBeInTheDocument();
  const detail = screen.getByText("Build ok");
  expect(toggle()).not.toContainElement(detail);
  unmount();
  render(<Harness row={withTask({ taskId: "b", state: "failed", summary: "Exit 2" })} />);
  expect(within(toggle()).getByText("Failed")).toBeInTheDocument();
  expect(screen.getByText("Exit 2")).toBeInTheDocument();
});

test("a background task the process took down: 'Stopped'", () => {
  render(<Harness row={withTask({ taskId: "b", state: "stopped" })} />);
  expect(within(toggle()).getByText("Stopped")).toBeInTheDocument();
});

test("a 64 KB single-line output: 'Show all', never 'Show all 1 line', and the cut tail starts with an ellipsis", async () => {
  const line = `${"x".repeat(64 * 1024 - 3)}END`;
  render(<Harness open row={bashRow({ command: "cat big" }, { content: line })} />);
  expect(screen.queryByRole("button", { name: /1 line/ })).toBeNull();
  const show = screen.getByRole("button", { name: "Show all" });
  expect(document.querySelector("pre")?.textContent?.startsWith("…x")).toBe(true);
  await userEvent.click(show);
  expect(document.querySelector("pre")?.textContent).toBe(line);
});

test("a one-line command short enough to read on the row needs no Show input, with a description too", () => {
  const command = "pnpm vitest run apps/web/src/features/a.test.ts";
  expect(command.length).toBeGreaterThan(40);
  render(
    <Harness open row={bashRow({ command, description: "Run the tests" }, { content: "ok" })} />,
  );
  expect(screen.queryByRole("button", { name: "Show input" })).not.toBeInTheDocument();
});

test("a call cut by Stop reads 'Interrupted', not 'Failed', with no error detail line", () => {
  resetSeq();
  const rows = buildRows(
    [
      { type: "turn_started" },
      { type: "tool_call", toolUseId: "tu1", name: "Bash", input: { command: "sleep 60" } },
      { type: "control", cmd: "interrupt", by: "@or" },
      {
        type: "tool_result",
        toolUseId: "tu1",
        content: "The user doesn't want to proceed with this tool use.",
        isError: true,
      },
    ].map((e) => se(e as AnyEvent)),
  ).rows;
  const row = rows.find((r) => r.kind === "tool") as ToolRow;
  render(<Harness row={row} />);
  expect(within(toggle()).getByText("Interrupted")).toBeInTheDocument();
  expect(screen.queryByText(/doesn't want to proceed/)).toBeNull();
});
