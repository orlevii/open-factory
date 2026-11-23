import { expect, test } from "vitest";
import { parseJson, parseYaml } from "./parse.ts";

test("yaml syntax error has line and column; paths map to lines", () => {
  expect(parseYaml("name: a\n  bad: [").error).toMatchObject({ line: 2 });
  const ok = parseYaml("name: a\nskills:\n  - x\n  - y\n");
  expect(ok.value).toEqual({ name: "a", skills: ["x", "y"] });
  expect(ok.lineOf(["skills", 1])).toBe(4);
});
test("json syntax error has line and column", () => {
  expect(parseJson('{\n  "a": 1,\n}').error).toMatchObject({ line: 3 });
  expect(parseJson('{"a":1}').value).toEqual({ a: 1 });
  // Constant-text messages keep V8's own wording and position.
  expect(parseJson('{\n  "a": "x').error).toMatchObject({
    message: "JSON: Unterminated string in JSON at position 11 (line 2 column 10)",
    line: 2,
    column: 10,
  });
  expect(parseJson('{"a": "\\q"}').error).toMatchObject({ line: 1 });
});
