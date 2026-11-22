import type { AnyEvent, ToolMeta } from "@open-factory/shared";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, expect, test } from "vitest";
import { resetSeq, se } from "@/test/session-fixtures";
import { formatBytes } from "../format";
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
    <div data-row>
      <ToolCallRow
        row={row}
        expanded={expanded}
        onToggle={() => setExpanded((x) => !x)}
        rowProps={{}}
      />
    </div>
  );
}

const toggle = () => screen.getByRole("button", { expanded: false });

test("collapsed: the description, then the command muted on the same line; a one-word chip", () => {
  render(<Harness row={bashRow({ command: "pnpm test --run", description: "Run the tests" })} />);
  const row = toggle();
  expect(row).toHaveTextContent(/^Run the testspnpm test --runRunning$/);
  expect(within(row).getByText("pnpm test --run")).toHaveClass("truncate", "text-muted-foreground");
  expect(within(row).getByText("Running")).toHaveClass("shrink-0");
  expect(row).toHaveClass("min-h-8");
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
  expect(detail.closest("p")).toHaveClass("pl-7");
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
  expect(line).toHaveTextContent(`Binary output · ${formatBytes(14_000)} · show raw`);
  expect(line).toHaveTextContent("Binary output · 14 KB · show raw");
  await userEvent.click(screen.getByRole("button", { name: "show raw" }));
  expect(document.querySelector("pre")).not.toBeNull();
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
  expect(screen.getByText("stderr")).toBeInTheDocument();
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
