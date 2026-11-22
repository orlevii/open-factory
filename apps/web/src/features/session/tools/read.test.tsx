import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import * as highlightModule from "@/components/markdown/highlight";
import { resetSeq } from "@/test/session-fixtures";
import { RowHarness, rowToggle, toolRow } from "./test-row";

beforeEach(() => resetSeq());

const PATH = "/work/app/src/retry.ts";
const numbered = (lines: string[], start = 1, sep = "→") =>
  lines.map((l, i) => `${String(start + i).padStart(6)}${sep}${l}`).join("\n");

test("collapsed text read: the file name · lines 1–120 of 340, the full path in its title", () => {
  render(
    <RowHarness
      row={toolRow(
        "Read",
        { file_path: PATH, limit: 120 },
        {
          content: numbered(["a"]),
          meta: { tool: "Read", kind: "text", startLine: 1, numLines: 120, totalLines: 340 },
        },
      )}
    />,
  );
  expect(rowToggle()).toHaveTextContent(/^retry\.ts · lines 1–120 of 340$/);
  expect(within(rowToggle()).getByTitle(PATH)).toBeInTheDocument();
});

test("collapsed text read with an offset: the range it read", () => {
  render(
    <RowHarness
      row={toolRow(
        "Read",
        { file_path: PATH, offset: 50, limit: 10 },
        {
          content: numbered(["a"], 50),
          meta: { tool: "Read", kind: "text", startLine: 50, numLines: 10, totalLines: 340 },
        },
      )}
    />,
  );
  expect(rowToggle()).toHaveTextContent("retry.ts · lines 50–59 of 340");
});

test("collapsed image read: the file name · image · its dimensions; the body shows nothing", async () => {
  render(
    <RowHarness
      row={toolRow(
        "Read",
        { file_path: "/tmp/screenshot.png" },
        {
          content: "[image]",
          meta: { tool: "ReadImage", bytes: 120_000, width: 1280, height: 720 },
        },
      )}
    />,
  );
  expect(rowToggle()).toHaveTextContent(/^screenshot\.png · image · 1280×720$/);
  await userEvent.click(rowToggle());
  expect(screen.queryByText("[image]")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Show content" })).not.toBeInTheDocument();
});

test("expanded text read: nothing until Show content, which strips the N→ prefixes into a gutter", async () => {
  const row = toolRow(
    "Read",
    { file_path: "/work/notes.txt" },
    {
      content: numbered(["first line", "second line", "third"]),
      meta: { tool: "Read", kind: "text", startLine: 1, numLines: 3, totalLines: 3 },
    },
  );
  const { container } = render(<RowHarness open row={row} />);
  expect(screen.queryByText(/first line/)).not.toBeInTheDocument();
  const show = screen.getByRole("button", { name: "Show content" });
  expect(show).toHaveAttribute("data-expands");
  await userEvent.click(show);
  const code = [...container.querySelectorAll("[data-code]")].map((c) => c.textContent);
  expect(code).toEqual(["first line", "second line", "third"]);
  const gutter = [...container.querySelectorAll("[data-gutter-number]")].map((g) => g.textContent);
  expect(gutter).toEqual(["1", "2", "3"]);
  expect(container).not.toHaveTextContent("→");
});

test("Show content reads the older tab-separated prefixes too, and keeps the file's numbers", async () => {
  const row = toolRow(
    "Read",
    { file_path: "/work/notes.txt", offset: 7 },
    { content: numbered(["seven", "eight"], 7, "\t") },
  );
  const { container } = render(<RowHarness open row={row} />);
  await userEvent.click(screen.getByRole("button", { name: "Show content" }));
  expect([...container.querySelectorAll("[data-code]")].map((c) => c.textContent)).toEqual([
    "seven",
    "eight",
  ]);
  expect([...container.querySelectorAll("[data-gutter-number]")].map((g) => g.textContent)).toEqual(
    ["7", "8"],
  );
});

test("Show content clamps long files, then Show all N lines in place", async () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
  const row = toolRow("Read", { file_path: "/work/a.txt" }, { content: numbered(lines) });
  const { container } = render(<RowHarness open row={row} />);
  await userEvent.click(screen.getByRole("button", { name: "Show content" }));
  expect(container.querySelectorAll("[data-code]")).toHaveLength(12);
  await userEvent.click(screen.getByRole("button", { name: "Show all 40 lines" }));
  expect(container.querySelectorAll("[data-code]")).toHaveLength(40);
});

test("Show content highlights a known extension", async () => {
  const row = toolRow("Read", { file_path: PATH }, { content: numbered(["const a = 1;"]) });
  const { container } = render(<RowHarness open row={row} />);
  await userEvent.click(screen.getByRole("button", { name: "Show content" }));
  await waitFor(() =>
    expect(container.querySelector("[data-code] span[style]")).toBeInTheDocument(),
  );
  expect(container.querySelector("[data-code]")).toHaveTextContent("const a = 1;");
});

test("Show content is text, never HTML", async () => {
  const row = toolRow("Read", { file_path: "/work/x.html" }, { content: numbered(["<b>x</b>"]) });
  const { container } = render(<RowHarness open row={row} />);
  await userEvent.click(screen.getByRole("button", { name: "Show content" }));
  expect(container.querySelector("[data-code]")).toHaveTextContent("<b>x</b>");
  await waitFor(() =>
    expect(container.querySelector("[data-code] span[style]")).toBeInTheDocument(),
  );
  expect(container.querySelector("[data-code]")).toHaveTextContent("<b>x</b>");
  expect(container.querySelector("b")).toBeNull();
});

test("Show content drops bidi and control characters, as diffs do (Trojan source)", async () => {
  const line = 'if (role === "user\u202e \u2066// admin\u2069 \u2066") {\u0007';
  const row = toolRow("Read", { file_path: "/work/x.txt" }, { content: numbered([line]) });
  const { container } = render(<RowHarness open row={row} />);
  await userEvent.click(screen.getByRole("button", { name: "Show content" }));
  const text = container.querySelector("[data-code]")?.textContent ?? "";
  expect(text).toBe('if (role === "user // admin ") {');
});

test("a failed read shows its error, not Show content", () => {
  render(
    <RowHarness
      open
      row={toolRow(
        "Read",
        { file_path: "/work/missing.ts" },
        { content: "<tool_use_error>File does not exist.</tool_use_error>", isError: true },
      )}
    />,
  );
  expect(rowToggle()).toHaveTextContent(/^missing\.tsFailed$/);
  expect(screen.queryByRole("button", { name: "Show content" })).not.toBeInTheDocument();
});

test("Show content highlights only the lines it shows; Show all highlights the rest", async () => {
  const spy = vi.spyOn(highlightModule, "highlightFile");
  const lines = Array.from({ length: 40 }, (_, i) => `const a${i} = ${i};`);
  const row = toolRow("Read", { file_path: PATH }, { content: numbered(lines) });
  const { container } = render(<RowHarness open row={row} />);
  await userEvent.click(screen.getByRole("button", { name: "Show content" }));
  await waitFor(() => expect(spy).toHaveBeenCalled());
  expect(spy.mock.calls.at(-1)?.[0].split("\n")).toHaveLength(12);
  await userEvent.click(screen.getByRole("button", { name: "Show all 40 lines" }));
  await waitFor(() => expect(spy.mock.calls.at(-1)?.[0].split("\n")).toHaveLength(40));
  await waitFor(() =>
    expect(
      container.querySelectorAll("[data-code]")[39]?.querySelector("span[style]"),
    ).not.toBeNull(),
  );
  spy.mockRestore();
});
