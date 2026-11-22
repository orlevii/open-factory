import { expect, test } from "vitest";
import { isBinary, stripAnsi, tailOutput } from "./output";

test("tailOutput: a 64 KB single line keeps at most 2,000 characters from its end", () => {
  const text = `${"a".repeat(64 * 1024 - 3)}END`;
  const r = tailOutput(text);
  expect(r.tail.length).toBeLessThanOrEqual(2000);
  expect(r.tail.endsWith("END")).toBe(true);
  expect(r).toMatchObject({ total: 1, cut: true });
});

test("tailOutput: cut by characters starts at a line start when it can", () => {
  const lines = Array.from(
    { length: 20 },
    (_, i) => `${String(i).padStart(2, "0")}${"x".repeat(298)}`,
  );
  const r = tailOutput(lines.join("\n"));
  // 12 lines are 3,611 characters; the last 2,000 begin mid-line, so the partial line goes.
  expect(r.tail).toBe(lines.slice(-6).join("\n"));
  expect(r).toMatchObject({ total: 20, cut: true });
});

test("tailOutput: the last 12 lines when they are shorter; nothing cut for a short output", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  expect(tailOutput(`${lines.join("\n")}\n`)).toEqual({
    tail: lines.slice(-12).join("\n"),
    total: 30,
    cut: true,
  });
  expect(tailOutput("a\nb\n")).toEqual({ tail: "a\nb", total: 2, cut: false });
  expect(tailOutput("")).toEqual({ tail: "", total: 0, cut: false });
});

test("stripAnsi: colours, cursor moves, OSC links and control characters go; tabs and newlines stay", () => {
  expect(stripAnsi("\u001b[31mred\u001b[0m\tok\r\nnext")).toBe("red\tok\nnext");
  expect(stripAnsi("\u001b]8;;https://x\u0007link\u001b]8;;\u0007")).toBe("link");
  expect(stripAnsi("a\u0000b\u0007c\u001b[2Kd\u009b")).toBe("abcd");
  // A progress bar redrawn with carriage returns keeps its last state.
  expect(stripAnsi("10%\r50%\r100%\ndone")).toBe("100%\ndone");
});

test("isBinary: more than 10% NUL, control or replacement characters", () => {
  expect(isBinary("plain text\nwith\ttabs\r\n")).toBe(false);
  expect(isBinary("\u001b[31mcoloured\u001b[0m output")).toBe(false);
  expect(isBinary(`${"\u0000".repeat(2)}${"a".repeat(18)}`)).toBe(false);
  expect(isBinary(`${"\u0000".repeat(3)}${"a".repeat(17)}`)).toBe(true);
  expect(isBinary(`PNG${"�".repeat(10)}ab`)).toBe(true);
  expect(isBinary("")).toBe(false);
});
