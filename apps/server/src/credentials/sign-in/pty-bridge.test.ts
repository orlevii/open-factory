import { describe, expect, it } from "vitest";
import { PTY_BRIDGE } from "./pty-bridge.ts";

describe("PTY_BRIDGE", () => {
  it("is fixed text: no template interpolation, no backtick", () => {
    expect(PTY_BRIDGE).not.toContain("${");
    expect(PTY_BRIDGE).not.toContain("`");
  });
  it("sets the window in the child before exec and kills the CLI's group", () => {
    expect(PTY_BRIDGE).toMatch(/TIOCSWINSZ/);
    expect(PTY_BRIDGE.indexOf("TIOCSWINSZ")).toBeLessThan(PTY_BRIDGE.indexOf("execvp"));
    expect(PTY_BRIDGE).toMatch(/killpg\(pid, signal\.SIGKILL\)/);
    expect(PTY_BRIDGE).toMatch(/SIGINT/);
  });
});
