import type { AnyEvent, ToolMeta, ToolMetaHunk } from "@open-factory/shared";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { resetSeq, se } from "@/test/session-fixtures";
import { buildRows, type ToolRow } from "../rows";
import { type StickToBottom, useStickToBottom } from "../stick-to-bottom";
import { ToolCallRow } from "../tool-call-row";

beforeEach(() => resetSeq());

function toolRow(
  name: string,
  input: Record<string, unknown>,
  result?: { content: string; meta?: ToolMeta },
): ToolRow {
  const events: AnyEvent[] = [{ type: "tool_call", toolUseId: "tu1", name, input }];
  if (result)
    events.push({
      type: "tool_result",
      toolUseId: "tu1",
      content: result.content,
      isError: false,
      ...(result.meta ? { meta: result.meta } : {}),
    });
  const row = buildRows(events.map((e) => se(e))).rows[0];
  if (row?.kind !== "tool") throw new Error("no tool row");
  return row;
}

function Harness({ row, open = false }: { row: ToolRow; open?: boolean }) {
  const [expanded, setExpanded] = useState(open);
  return (
    <div data-row="r" tabIndex={-1}>
      <ToolCallRow
        row={row}
        expanded={expanded}
        onToggle={() => setExpanded((x) => !x)}
        rowProps={{}}
      />
    </div>
  );
}

const HUNK: ToolMetaHunk = {
  oldStart: 10,
  oldLines: 3,
  newStart: 10,
  newLines: 4,
  lines: [" keep", "-old b", "+new B", "+new C", " tail"],
};
const PATH = "/work/repo/src/features/session/retry.ts";
const edit = (hunks: ToolMetaHunk[], partial?: boolean) =>
  toolRow(
    "Edit",
    { file_path: PATH, old_string: "x", new_string: "y" },
    {
      content: "The file has been updated.",
      meta: { tool: "Edit", hunks, ...(partial ? { partial } : {}) },
    },
  );

/** n context lines starting at `start`. */
const hunkOf = (start: number, n: number): ToolMetaHunk => ({
  oldStart: start,
  oldLines: n,
  newStart: start,
  newLines: n,
  lines: Array.from({ length: n }, (_, i) => `+line ${start + i}`),
});

/** Each rendered diff line: its gutter number, sign and code. */
const diffLines = () =>
  [...document.querySelectorAll<HTMLElement>("[data-diff-line]")].map((l) => [
    l.querySelector("[data-gutter-number]")?.textContent,
    l.querySelector("[data-sign]")?.textContent,
    l.querySelector("[data-code]")?.textContent,
  ]);

test("collapsed: the path middle-truncated, then +N −M that never shrinks", () => {
  render(<Harness row={edit([HUNK])} />);
  const row = screen.getByRole("button", { expanded: false });
  expect(row).toHaveTextContent(`${PATH} · +2 −1`);
  expect(within(row).getByText("+2 −1")).toHaveClass("shrink-0");
  // MiddleTruncate keeps the file name: the tail is its own non-shrinking span.
  expect(within(row).getByText("/retry.ts")).toHaveClass("shrink-0");
});

test("expanded: one gutter column (new line numbers; old on − lines), signs, code in ink", () => {
  render(<Harness open row={edit([HUNK])} />);
  expect(diffLines()).toEqual([
    ["10", " ", "keep"],
    ["11", "−", "old b"],
    ["11", "+", "new B"],
    ["12", "+", "new C"],
    ["13", " ", "tail"],
  ]);
  const lines = document.querySelectorAll<HTMLElement>("[data-diff-line]");
  expect([...lines].map((l) => l.dataset.diffLine)).toEqual([
    "context",
    "remove",
    "add",
    "add",
    "context",
  ]);
  // The gutter (number and sign) sticks while the plate scrolls sideways.
  const gutter = lines[1]?.querySelector("[data-gutter-number]")?.parentElement;
  expect(gutter).toHaveClass("sticky", "left-0");
  expect(lines[0]?.closest("[data-diff]")).toHaveClass("overflow-x-auto");
  // No syntax colour: the code is plain text in ink.
  const code = lines[2]?.querySelector("[data-code]") as HTMLElement;
  expect(code.children).toHaveLength(0);
  expect(document.querySelector(".shiki")).toBeNull();
});

test("expanded: code is text, never HTML", () => {
  render(<Harness open row={edit([{ ...HUNK, lines: ["+<img src=x onerror=alert(1)>"] }])} />);
  expect(document.querySelector("img")).toBeNull();
  expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
});

test("the first 3 hunks, then Show all N lines", async () => {
  render(<Harness open row={edit([1, 20, 40, 60, 80].map((s) => hunkOf(s, 2)))} />);
  expect(diffLines().map((l) => l[0])).toEqual(["1", "2", "20", "21", "40", "41"]);
  await userEvent.click(screen.getByRole("button", { name: "Show all 10 lines" }));
  expect(diffLines()).toHaveLength(10);
  expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
});

test("at most 80 lines, then Show all N lines", () => {
  render(<Harness open row={edit([hunkOf(1, 100)])} />);
  expect(diffLines()).toHaveLength(80);
  expect(screen.getByRole("button", { name: "Show all 100 lines" })).toBeInTheDocument();
});

function InLog({ api, row }: { api: { current?: StickToBottom }; row: ToolRow }) {
  const scroller = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement>(null);
  api.current = useStickToBottom(scroller, log);
  return (
    <div ref={scroller}>
      <div role="log" ref={log}>
        <Harness open row={row} />
      </div>
    </div>
  );
}

test("Show all anchors its row through the timeline's expandAnchor before it expands", () => {
  vi.stubGlobal("ResizeObserver", undefined);
  try {
    const api: { current?: StickToBottom } = {};
    render(<InLog api={api} row={edit([1, 20, 40, 60].map((s) => hunkOf(s, 2)))} />);
    const expandAnchor = vi.spyOn(api.current as StickToBottom, "expandAnchor");
    let linesWhenAnchored = 0;
    expandAnchor.mockImplementation(() => {
      linesWhenAnchored = diffLines().length;
    });
    fireEvent.click(screen.getByRole("button", { name: "Show all 8 lines" }));
    expect(expandAnchor).toHaveBeenCalledWith(document.querySelector('[data-row="r"]'));
    expect(linesWhenAnchored).toBe(6);
    expect(diffLines()).toHaveLength(8);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("partial: Diff truncated · show raw output", async () => {
  render(<Harness open row={edit([HUNK], true)} />);
  const line = screen.getByText(/^Diff truncated/).closest("p");
  expect(line).toHaveTextContent("Diff truncated · show raw output");
  await userEvent.click(screen.getByRole("button", { name: "show raw output" }));
  expect(screen.getByText("The file has been updated.")).toBeInTheDocument();
});

test("a create: 'created · N lines' and the input's first 20 lines as + lines", async () => {
  const content = `${Array.from({ length: 120 }, (_, i) => `row ${i + 1}`).join("\n")}\n`;
  render(
    <Harness
      row={toolRow(
        "Write",
        { file_path: "/w/notes.md", content },
        {
          content: "File created successfully at: /w/notes.md",
          meta: { tool: "Write", type: "create", hunks: [] },
        },
      )}
    />,
  );
  const row = screen.getByRole("button", { expanded: false });
  expect(row).toHaveTextContent("/w/notes.md · created · 120 lines");
  expect(within(row).getByText("created · 120 lines")).toHaveClass("shrink-0");
  await userEvent.click(row);
  const lines = diffLines();
  expect(lines).toHaveLength(20);
  expect(lines[0]).toEqual(["1", "+", "row 1"]);
  expect(lines[19]).toEqual(["20", "+", "row 20"]);
  expect(screen.getByRole("button", { name: "Show all 120 lines" })).toBeInTheDocument();
});

test("MultiEdit and a Write update render their hunks the same way", () => {
  render(
    <>
      <Harness
        open
        row={toolRow(
          "MultiEdit",
          { file_path: "/a.ts", edits: [] },
          { content: "ok", meta: { tool: "MultiEdit", hunks: [HUNK] } },
        )}
      />
      <Harness
        open
        row={toolRow(
          "Write",
          { file_path: "/b.ts", content: "x" },
          { content: "ok", meta: { tool: "Write", type: "update", hunks: [HUNK] } },
        )}
      />
    </>,
  );
  expect(diffLines()).toHaveLength(10);
  expect(screen.getAllByText("+2 −1")).toHaveLength(2);
});

test("no meta (an older row, or no result yet): today's row", () => {
  render(<Harness open row={toolRow("Edit", { file_path: "/a.ts" }, { content: "done" })} />);
  const row = screen.getByRole("button", { expanded: true });
  expect(within(row).getByText("Edit")).toHaveClass("font-mono");
  expect(document.querySelector("[data-diff]")).toBeNull();
  expect([...document.querySelectorAll("pre")].map((p) => p.textContent)).toEqual([
    JSON.stringify({ file_path: "/a.ts" }, null, 2),
    "done",
  ]);
});
