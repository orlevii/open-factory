import { Text } from "@codemirror/state";
import { describe, expect, test } from "vitest";
import { toDiagnostics } from "./code-editor-setup";

const doc = Text.of(["first", "second", "third line", "fourth"]);

describe("toDiagnostics", () => {
  test("maps a line and a 1-based column to offsets running to the line's end", () => {
    const [d] = toDiagnostics(doc, [{ line: 3, column: 5, message: "bad", severity: "error" }]);
    const line3 = doc.line(3);
    expect(d).toMatchObject({
      from: line3.from + 4,
      to: line3.to,
      message: "bad",
      severity: "error",
    });
  });

  test("a missing column covers the whole line", () => {
    const [d] = toDiagnostics(doc, [{ line: 2, message: "meh", severity: "warning" }]);
    expect(d).toMatchObject({ from: doc.line(2).from, to: doc.line(2).to, severity: "warning" });
  });

  test("a line past the end of the doc is dropped", () => {
    const out = toDiagnostics(doc, [
      { line: 9, message: "gone", severity: "error" },
      { line: 1, message: "kept", severity: "error" },
    ]);
    expect(out.map((d) => d.message)).toEqual(["kept"]);
  });

  test("a column past the line's end is clamped to it", () => {
    const [d] = toDiagnostics(doc, [{ line: 1, column: 99, message: "x", severity: "error" }]);
    expect(d).toMatchObject({ from: doc.line(1).to, to: doc.line(1).to });
  });
});
