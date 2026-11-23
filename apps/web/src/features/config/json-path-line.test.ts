import { expect, test } from "vitest";
import { jsonPathToLine } from "./json-path-line";

const TEXT = `{
  "template": {
    "model": "opus",
    "skills": [
      "release",
      "triage"
    ]
  },
  "mcp": {
    "mcpServers": {
      "ctx.io": { "url": "https://x" },
      "gh": {
        "env": { "T": "x" }
      }
    }
  }
}`;

test("a key's line, at any depth", () => {
  expect(jsonPathToLine(TEXT, "template")).toBe(2);
  expect(jsonPathToLine(TEXT, "template.model")).toBe(3);
  expect(jsonPathToLine(TEXT, "mcp.mcpServers.gh.env.T")).toBe(13);
});

test("a list index is the element's line", () => {
  expect(jsonPathToLine(TEXT, "template.skills.0")).toBe(5);
  expect(jsonPathToLine(TEXT, "template.skills.1")).toBe(6);
});

test("a key holding a dot is matched whole", () => {
  expect(jsonPathToLine(TEXT, "mcp.mcpServers.ctx.io")).toBe(11);
  expect(jsonPathToLine(TEXT, "mcp.mcpServers.ctx.io.url")).toBe(11);
});

test("a path the text doesn't have falls back to its deepest present ancestor", () => {
  expect(jsonPathToLine(TEXT, "template.skills.7")).toBe(4);
  expect(jsonPathToLine(TEXT, "template.effort")).toBe(2);
  expect(jsonPathToLine(TEXT, "settings.permissions.allow.0")).toBeUndefined();
});

test("no path, an empty path or the root is line 1", () => {
  expect(jsonPathToLine(TEXT, "")).toBe(1);
  expect(jsonPathToLine("\n\n{}", "")).toBe(3);
});

test("strings with escapes, braces and newlines in them don't confuse the lines", () => {
  const t = '{\n  "a": "x\\"}{[\\n",\n  "b": {\n    "c": 1\n  }\n}';
  expect(jsonPathToLine(t, "b.c")).toBe(4);
});

test("invalid JSON never throws: the part read so far still answers", () => {
  const t = '{\n  "a": {\n    "b": 1,\n    oops';
  expect(jsonPathToLine(t, "a.b")).toBe(3);
  expect(jsonPathToLine(t, "a.zzz")).toBe(2);
  expect(() => jsonPathToLine("[[[", "0.0.0")).not.toThrow();
  expect(jsonPathToLine("", "a")).toBeUndefined();
});
