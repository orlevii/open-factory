import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PTY_BRIDGE } from "./pty-bridge.ts";

describe("PTY_BRIDGE", () => {
  it("is fixed text: the source template has no interpolation and no backtick", () => {
    // PTY_BRIDGE is a String.raw template, so an interpolation would already be evaluated in
    // the exported string. Check the source text of the template body instead.
    const source = readFileSync(new URL("./pty-bridge.ts", import.meta.url), "utf8");
    const open = source.indexOf("String.raw`");
    expect(open).toBeGreaterThanOrEqual(0);
    const body = source.slice(open + "String.raw`".length);
    const close = body.indexOf("`");
    expect(close).toBeGreaterThan(0);
    const template = body.slice(0, close);
    expect(template).not.toContain("${");
    // Exactly one template: nothing but a terminator follows the closing backtick.
    expect(body.slice(close + 1).replace(/^;\s*/, "")).not.toContain("`");
    expect(template).toBe(PTY_BRIDGE);
  });
  it("sets the window in the child before exec and kills the CLI's group", () => {
    expect(PTY_BRIDGE).toMatch(/TIOCSWINSZ/);
    expect(PTY_BRIDGE.indexOf("TIOCSWINSZ")).toBeLessThan(PTY_BRIDGE.indexOf("execvp"));
    expect(PTY_BRIDGE).toMatch(/killpg\(pid, signal\.SIGKILL\)/);
    expect(PTY_BRIDGE).toMatch(/SIGINT/);
  });
});
