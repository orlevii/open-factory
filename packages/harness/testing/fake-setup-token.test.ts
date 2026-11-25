import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createFakeClaude } from "./index.js";
import { SYNTHETIC_CODE, SYNTHETIC_TOKEN, SYNTHETIC_URL } from "./synthetic-sign-in.mjs";

const hasPython = spawnSync("python3", ["--version"]).status === 0;
if (!hasPython && process.env.CI) throw new Error("python3 is required for fake-setup-token tests");

// Test-only pty harness: no secrets, drives the fake wrapper only.
const HARNESS = String.raw`
import os, pty, sys, time, select
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
codes = [c.encode() for c in os.environ["CODE"].split(",")]
bads = codes.count(b"bad")
out = b""; sent = 0; t0 = time.time()
while time.time() - t0 < 10:
    r, _, _ = select.select([fd], [], [], 0.05)
    if fd in r:
        try: d = os.read(fd, 65536)
        except OSError: break
        if not d: break
        out += d
    # the first code after the prompt, each later one after a "Press Enter to retry"
    if sent < len(codes) and b"Paste code here" in out and out.count(b"Press Enter to retry") == sent:
        code = codes[sent]; sent += 1
        os.write(fd, code); time.sleep(0.15); os.write(fd, b"\r")
    # a final bad code never exits on its own: stop once every bad code has been rejected
    if sent == len(codes) and codes[-1] == b"bad" and out.count(b"OAuth error:") >= bads:
        break
sys.stdout.buffer.write(out)
try:
    os.kill(pid, 9)
except ProcessLookupError:
    pass
_, st = os.waitpid(pid, 0)
sys.stderr.write("exit=%d\n" % os.waitstatus_to_exitcode(st))
`;

const fake = createFakeClaude({ scenario: "reply" });
const pidFile = path.join(fake.dir, "setup-token.pid");
const env = { PATH: process.env.PATH ?? "", TERM: "xterm" };
const pty = (code: string) =>
  spawnSync("python3", ["-c", HARNESS, fake.bin, "setup-token"], {
    env: { ...env, CODE: code },
    encoding: "utf8",
    timeout: 20_000,
  });
const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
};

// A pid left by an earlier run would make the liveness check pass without proving anything.
beforeEach(() => rmSync(pidFile, { force: true }));

afterAll(() => {
  try {
    process.kill(Number(readFileSync(pidFile, "utf8")), 9);
  } catch {}
});

describe.skipIf(!hasPython)("fake claude setup-token", () => {
  it("shows the sign-in screen and prints the token after the code", () => {
    const r = pty(SYNTHETIC_CODE);
    // words are separated by cursor-horizontal-absolute moves, as the real screen does
    expect(r.stdout.replaceAll("\x1b[9G", " ")).toContain("the url below to sign in");
    expect(r.stdout).toContain(`\x1b]8;;${SYNTHETIC_URL}\x1b\\`);
    expect(r.stdout).toContain("Paste code here if prompted");
    expect(r.stdout).toContain(SYNTHETIC_TOKEN.slice(0, 30));
    expect(r.stdout).toContain(SYNTHETIC_TOKEN.slice(-20));
    expect(r.stderr).toContain("exit=0");
  });

  it("reports a bad code and leaves nothing running once killed", () => {
    const r = pty("bad");
    expect(r.stdout).toContain("OAuth error:");
    expect(gone(Number(readFileSync(pidFile, "utf8")))).toBe(true);
  });

  it("judges each retry on its own: bad again fails, a good code then succeeds", () => {
    const twice = pty("bad,bad");
    expect(twice.stdout.split("OAuth error:")).toHaveLength(3);
    expect(twice.stdout).not.toContain(SYNTHETIC_TOKEN.slice(0, 30));
    expect(gone(Number(readFileSync(pidFile, "utf8")))).toBe(true);
    rmSync(pidFile, { force: true });
    const r = pty(`bad,${SYNTHETIC_CODE}`);
    expect(r.stdout).toContain("OAuth error:");
    expect(r.stdout).toContain(SYNTHETIC_TOKEN.slice(0, 30));
    expect(r.stderr).toContain("exit=0");
  });

  it("exits 1 without a tty", () => {
    const r = spawnSync(fake.bin, ["setup-token"], { env, encoding: "utf8", input: "" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Raw mode is not supported");
  });
});
