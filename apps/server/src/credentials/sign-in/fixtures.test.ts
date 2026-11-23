import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SYNTHETIC_URL } from "../../../../../packages/harness/testing/synthetic-sign-in.mjs";
import { parsePrompt, parseToken, stripTerminal } from "./setup-token.ts";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const SYNTHETIC_VALUES = [
  SYNTHETIC_URL.match(/[?&]code_challenge=([^&]+)/)![1]!,
  SYNTHETIC_URL.match(/[?&]state=([^&]+)/)![1]!,
];

const URL_LINE = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;

/** Strip the terminal codes, then re-join hard-wrapped URL lines so values are not cut at a wrap. */
function joinedText(raw: string): string {
  const lines: string[] = [];
  let prevWasUrl = false;
  for (const line of stripTerminal(raw).split("\n")) {
    const t = line.trim();
    if (prevWasUrl && URL_LINE.test(t) && !t.startsWith("https://")) lines[lines.length - 1] += t;
    else lines.push(t);
    prevWasUrl = URL_LINE.test(t);
  }
  return lines.join("\n");
}

function sections(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  let name: string | null = null;
  let body: string[] = [];
  const flush = () => {
    if (name !== null) map.set(name, body.join("\n"));
  };
  for (const line of raw.split("\n")) {
    const m = /^=== (.+) ===$/.exec(line);
    if (m) {
      flush();
      name = m[1]!;
      body = [];
    } else body.push(line);
  }
  flush();
  return map;
}

const files = readdirSync(DIR).filter((f) => f.startsWith("setup-token."));

describe("fixtures", () => {
  it("has at least the synthetic fixture", () =>
    expect(files).toContain("setup-token.SYNTHETIC.txt"));

  describe.each(files)("%s", (file) => {
    const raw = readFileSync(path.join(DIR, file), "utf8");

    it("holds no real-looking token", () => expect(raw).not.toMatch(/sk-ant-oat01-(?!SYNTHETIC)/));

    it("uses only synthetic code_challenge and state values", () => {
      const values = [
        ...joinedText(raw).matchAll(/\b(?:code_challenge|state)=([A-Za-z0-9_-]*)/g),
      ].map((m) => m[1]!);
      expect(values.length).toBeGreaterThan(0);
      for (const v of values) expect(SYNTHETIC_VALUES).toContain(v);
    });

    it("parses every prompt and success section", () => {
      const secs = [...sections(raw)];
      for (const [name, body] of secs) {
        if (name.startsWith("prompt")) expect(parsePrompt(body), name).not.toBeNull();
        if (name.startsWith("success")) expect(parseToken(body), name).not.toBeNull();
      }
      expect(secs.some(([n]) => n.startsWith("prompt"))).toBe(true);
    });
  });
});
