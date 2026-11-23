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
        {
          file: "/a.ts",
          lines: [
            { text: "3:const x = 1", match: true },
            { text: "9:x++", match: true },
          ],
        },
        { file: "/b.ts", lines: [{ text: "1:import x", match: true }] },
      ],
    });
  });
  test("a match in a file whose name starts with a known file and a dash is a match, not context", () => {
    const r = parseSearch(
      ["src/a.ts:1:x", "src/a.ts-old.ts:3:x", "src/a.ts-2-ctx"].join("\n"),
      "content",
    );
    expect(r).toEqual({
      kind: "content",
      count: 2,
      groups: [
        { file: "src/a.ts", lines: [{ text: "1:x", match: true }] },
        { file: "src/a.ts-old.ts", lines: [{ text: "3:x", match: true }] },
        { file: "src/a.ts", lines: [{ text: "2-ctx", match: false }] },
      ],
    });
  });
  test("context lookup stays linear in the number of files", () => {
    const files = Array.from({ length: 2000 }, (_, i) => `src/dir/file-${i}.ts`);
    const lines = files.flatMap((f) => [`${f}:1:hit`, `${f}-2-ctx`]);
    const t = performance.now();
    const r = parseSearch(lines.join("\n"), "content");
    expect(performance.now() - t).toBeLessThan(100);
    expect(r.count).toBe(2000);
  });
  test("context lines (path-N-text) and -- separators are shown but never counted", () => {
    const r = parseSearch(
      [
        "src/retry-policy.ts-10-// before",
        "src/retry-policy.ts:11:const retries = 3;",
        "src/retry-policy.ts-12-// after: with a colon",
        "--",
        "src/retry-policy.ts-40-x",
        "src/retry-policy.ts:41:retries++",
        "src/b.ts:1:import { retries } from './retry-policy';",
      ].join("\n"),
      "content",
    );
    expect(r.count).toBe(3);
    expect(r).toEqual({
      kind: "content",
      count: 3,
      groups: [
        {
          file: "src/retry-policy.ts",
          lines: [
            { text: "10-// before", match: false },
            { text: "11:const retries = 3;", match: true },
            { text: "12-// after: with a colon", match: false },
            { text: "40-x", match: false },
            { text: "41:retries++", match: true },
          ],
        },
        {
          file: "src/b.ts",
          lines: [{ text: "1:import { retries } from './retry-policy';", match: true }],
        },
      ],
    });
  });
  test("count mode: path:N lines, totals from the closing Found line", () => {
    const r = parseSearch(
      "src/a.ts:3\nsrc/b-c.ts:8\nsrc/d.ts:1\n\nFound 12 total occurrences across 3 files.",
      "count",
    );
    expect(r).toEqual({
      kind: "counts",
      count: 12,
      fileCount: 3,
      files: [
        { file: "src/a.ts", n: 3 },
        { file: "src/b-c.ts", n: 8 },
        { file: "src/d.ts", n: 1 },
      ],
    });
  });
  test("count mode without the Found line sums the lines; odd lines stay plain", () => {
    const r = parseSearch("src/a.ts:3\nsomething else\nsrc/b.ts:2", "count");
    expect(r).toEqual({
      kind: "counts",
      count: 5,
      fileCount: 3,
      files: [{ file: "src/a.ts", n: 3 }, { file: "something else" }, { file: "src/b.ts", n: 2 }],
    });
  });
  test("content hits without a file prefix stay in one unnamed group", () => {
    const r = parseSearch("just a line\nanother", "content");
    expect(r).toEqual({
      kind: "content",
      count: 2,
      groups: [
        {
          file: "",
          lines: [
            { text: "just a line", match: true },
            { text: "another", match: true },
          ],
        },
      ],
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

test("expanded: the first 20 files as rows, then Show all N files in place", async () => {
  const content = `Found 26 files\n${files(26).join("\n")}`;
  render(<RowHarness open row={toolRow("Grep", { pattern: "x" }, { content })} />);
  const items = screen.getAllByRole("listitem");
  expect(items).toHaveLength(20);
  expect(items[0]).toHaveTextContent("/work/app/src/f1.ts");
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

test("collapsed count search: matches in files; expanded: each file with its count", () => {
  const content = "src/a.ts:3\nsrc/b.ts:9\nFound 12 total occurrences across 2 files.";
  render(
    <RowHarness
      open
      row={toolRow("Grep", { pattern: "retry", output_mode: "count" }, { content })}
    />,
  );
  expect(rowToggle()).toHaveTextContent(/^retry · 12 matches in 2 files$/);
  const items = screen.getAllByRole("listitem");
  expect(items.map((i) => i.textContent)).toEqual(["src/a.ts · 3", "src/b.ts · 9"]);
  expect(screen.queryByText(/Found 12/)).not.toBeInTheDocument();
});

test("expanded content search with context: context lines are marked, matches counted", () => {
  const content = "/a.ts-2-before\n/a.ts:3:const x = 1\n/a.ts-4-after\n--\n/b.ts:1:import x";
  const { container } = render(
    <RowHarness
      open
      row={toolRow("Grep", { pattern: "x", output_mode: "content", "-C": 1 }, { content })}
    />,
  );
  expect(rowToggle()).toHaveTextContent("x · 2 matches");
  expect([...container.querySelectorAll("[data-context]")].map((e) => e.textContent)).toEqual([
    "2-before",
    "4-after",
  ]);
  expect(screen.getAllByText("/a.ts")).toHaveLength(1);
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
  expect(rowToggle()).toHaveTextContent(/^\(Failed$/);
  expect(document.querySelector("pre")).toHaveTextContent("regex parse error");
});

test("an unexpected input shape never throws", () => {
  render(<RowHarness open row={toolRow("Glob", null, { content: "weird" })} />);
  expect(rowToggle()).toBeInTheDocument();
});
