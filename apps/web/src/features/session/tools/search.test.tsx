import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test } from "vitest";
import { resetSeq } from "@/test/session-fixtures";
import { parseSearch } from "./search";
import { RowHarness, rowToggle, toolRow } from "./test-row";

beforeEach(() => resetSeq());

const files = (n: number) => Array.from({ length: n }, (_, i) => `/work/app/src/f${i + 1}.ts`);

describe("parseSearch", () => {
  test("Found N files, then the list", () => {
    expect(parseSearch("Found 2 files\n/a.ts\n/b.ts", "files")).toEqual({
      kind: "files",
      count: 2,
      files: ["/a.ts", "/b.ts"],
    });
  });
  test("Found 1 file", () => {
    expect(parseSearch("Found 1 file\n/a.ts", "files").count).toBe(1);
  });
  test("a bare list (Glob) counts its lines and drops the truncation note", () => {
    const r = parseSearch(
      "/a.ts\n/b.ts\n/c.ts\n(Results are truncated. Consider using a more specific path or pattern.)\n",
      "files",
    );
    expect(r).toEqual({ kind: "files", count: 3, files: ["/a.ts", "/b.ts", "/c.ts"] });
  });
  test("no results", () => {
    expect(parseSearch("No files found", "files")).toEqual({ kind: "files", count: 0, files: [] });
    expect(parseSearch("No matches found", "content").count).toBe(0);
    expect(parseSearch("", "files").count).toBe(0);
  });
  test("the list is bounded to 200 with the true count", () => {
    const r = parseSearch(`Found 500 files\n${files(500).join("\n")}`, "files");
    expect(r.count).toBe(500);
    expect(r.kind === "files" && r.files.length).toBe(200);
  });
  test("content hits group by file", () => {
    const r = parseSearch("/a.ts:3:const x = 1\n/a.ts:9:x++\n/b.ts:1:import x", "content");
    expect(r).toEqual({
      kind: "content",
      count: 3,
      groups: [
        { file: "/a.ts", hits: ["3:const x = 1", "9:x++"] },
        { file: "/b.ts", hits: ["1:import x"] },
      ],
    });
  });
  test("content hits without a file prefix stay in one unnamed group", () => {
    const r = parseSearch("just a line\nanother", "content");
    expect(r).toEqual({
      kind: "content",
      count: 2,
      groups: [{ file: "", hits: ["just a line", "another"] }],
    });
  });
});

test("collapsed Grep: pattern in path · 6 files, from Found N files", () => {
  render(
    <RowHarness
      row={toolRow(
        "Grep",
        { pattern: "retryCount", path: "apps/web" },
        { content: `Found 6 files\n${files(6).join("\n")}` },
      )}
    />,
  );
  expect(rowToggle()).toHaveTextContent(/^retryCount in apps\/web · 6 files$/);
});

test("collapsed Glob without a path: pattern · N files, from the line count", () => {
  render(
    <RowHarness row={toolRow("Glob", { pattern: "**/*.tsx" }, { content: files(3).join("\n") })} />,
  );
  expect(rowToggle()).toHaveTextContent(/^\*\*\/\*\.tsx · 3 files$/);
});

test("collapsed while running: the pattern alone", () => {
  render(<RowHarness row={toolRow("Grep", { pattern: "todo", path: "src" })} />);
  expect(rowToggle()).toHaveTextContent(/^todo in srcRunning$/);
});

test("expanded: the first 20 files as mono rows, then Show all N files in place", async () => {
  const content = `Found 26 files\n${files(26).join("\n")}`;
  render(<RowHarness open row={toolRow("Grep", { pattern: "x" }, { content })} />);
  const items = screen.getAllByRole("listitem");
  expect(items).toHaveLength(20);
  expect(items[0]).toHaveTextContent("/work/app/src/f1.ts");
  expect(items[0]).toHaveClass("font-mono");
  const all = screen.getByRole("button", { name: "Show all 26 files" });
  expect(all).toHaveAttribute("data-expands");
  await userEvent.click(all);
  expect(screen.getAllByRole("listitem")).toHaveLength(26);
  expect(screen.queryByRole("button", { name: /Show all/ })).not.toBeInTheDocument();
});

test("expanded past the 200-file bound: says how many more there are", async () => {
  const content = `Found 250 files\n${files(250).join("\n")}`;
  render(<RowHarness open row={toolRow("Glob", { pattern: "**" }, { content })} />);
  await userEvent.click(screen.getByRole("button", { name: "Show all 250 files" }));
  expect(screen.getAllByRole("listitem")).toHaveLength(200);
  expect(screen.getByText("and 50 more")).toBeInTheDocument();
});

test("expanded content search: hits grouped under their file", () => {
  const content = "/a.ts:3:const x = 1\n/a.ts:9:x++\n/b.ts:1:import x";
  render(
    <RowHarness
      open
      row={toolRow("Grep", { pattern: "x", output_mode: "content", "-n": true }, { content })}
    />,
  );
  expect(rowToggle()).toHaveTextContent("x · 3 matches");
  expect(screen.getByText("/a.ts")).toBeInTheDocument();
  expect(screen.getByText("3:const x = 1")).toBeInTheDocument();
  expect(screen.getByText("/b.ts")).toBeInTheDocument();
});

test("no results read as such", () => {
  render(
    <RowHarness open row={toolRow("Grep", { pattern: "zzz" }, { content: "No files found" })} />,
  );
  expect(rowToggle()).toHaveTextContent(/^zzz · no files$/);
  expect(screen.queryAllByRole("listitem")).toHaveLength(0);
});

test("a failed search shows its error output", () => {
  render(
    <RowHarness
      open
      row={toolRow(
        "Grep",
        { pattern: "(" },
        { content: "regex parse error: unclosed group", isError: true },
      )}
    />,
  );
  expect(rowToggle()).toHaveTextContent(/^\( Failed$|^\(Failed$/);
  expect(document.querySelector("pre")).toHaveTextContent("regex parse error");
});

test("an unexpected input shape never throws", () => {
  render(<RowHarness open row={toolRow("Glob", null, { content: "weird" })} />);
  expect(rowToggle()).toBeInTheDocument();
});
