import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createFakeClaude } from "@open-factory/harness/testing";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import {
  bridgeEnv,
  bridgeSpawnArgs,
  PtyUnavailable,
  probePython,
  startHostPty,
  sweepStaleDirs,
} from "./host-pty.ts";
import { PTY_BRIDGE } from "./pty-bridge.ts";

const hasPython = spawnSync("python3", ["--version"]).status === 0;

/** A stand-in for the bridge process. It never reports a CLI pid, so the transport's group kill
 *  can never reach a real process from these tests. Closing stdin or kill() ends it. */
function fakeChild(
  o: { error?: NodeJS.ErrnoException; stderr?: string; exitOnKill?: boolean } = {},
) {
  const c = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    stdio: PassThrough[];
    pid: number | undefined;
    kills: string[];
    kill(sig?: string): boolean;
  };
  c.stdin = new PassThrough();
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.stdio = [c.stdin, c.stdout, c.stderr, new PassThrough()];
  c.pid = o.error ? undefined : 999_999;
  c.kills = [];
  let closed = false;
  const close = (code: number | null, signal: string | null) => {
    if (closed) return;
    closed = true;
    for (const s of c.stdio.slice(1)) s.end();
    setImmediate(() => c.emit("close", code, signal));
  };
  c.kill = (sig = "SIGTERM") => {
    c.kills.push(sig);
    if (o.exitOnKill !== false) close(null, sig);
    return true;
  };
  c.stdin.on("finish", () => close(1, null));
  process.nextTick(() => {
    if (o.error) {
      c.emit("error", o.error);
      return;
    }
    c.emit("spawn");
    if (o.stderr) c.stderr.write(o.stderr);
  });
  return c;
}

describe("bridgeSpawnArgs and bridgeEnv", () => {
  it("argv is the fixed script, the configured bin and the literal setup-token", () => {
    expect(bridgeSpawnArgs("/opt/claude")).toEqual([
      "-I",
      "-S",
      "-c",
      PTY_BRIDGE,
      "/opt/claude",
      "setup-token",
    ]);
  });
  it("env leaves out PATH and LANG when the server has none", () => {
    expect(bridgeEnv({ DATABASE_URL: "postgres://x" }, "/t/d")).toEqual({
      TERM: "xterm-256color",
      HOME: "/t/d",
      CLAUDE_CONFIG_DIR: "/t/d",
      BROWSER: "true",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
    });
  });
});

describe("startHostPty with a spawn spy", () => {
  it("spawns python3 with the exact argv, env allow-list, detached and four pipes", async () => {
    const calls: unknown[][] = [];
    const spawnFn = ((...a: unknown[]) => {
      calls.push(a);
      return fakeChild();
    }) as never;
    const run = await startHostPty({
      claudeBin: "/opt/claude",
      serverEnv: {
        PATH: "/usr/bin",
        LANG: "en_US.UTF-8",
        DATABASE_URL: "postgres://x",
        FACTORY_SECRET_KEY: "k",
        GH_TOKEN: "g",
        CLAUDE_CODE_OAUTH_TOKEN: "t",
      },
      spawnFn,
    });
    const [cmd, args, opts] = calls[0] as [
      string,
      string[],
      { env: Record<string, string>; detached: boolean; stdio: string[] },
    ];
    expect(cmd).toBe("python3");
    expect(args).toEqual(["-I", "-S", "-c", PTY_BRIDGE, "/opt/claude", "setup-token"]);
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toEqual(["pipe", "pipe", "pipe", "pipe"]);
    expect(opts.env).toEqual({
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
      HOME: run.dir,
      CLAUDE_CONFIG_DIR: run.dir,
      BROWSER: "true",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
    });
    expect(path.basename(run.dir).startsWith("of-sign-in-")).toBe(true);
    expect((await stat(run.dir)).mode & 0o777).toBe(0o700);
    run.kill();
    await run.exit;
    await expect(stat(run.dir)).rejects.toThrow();
  });

  it("ENOENT is PtyUnavailable", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "of-test-enoent-"));
    const err = Object.assign(new Error("spawn python3 ENOENT"), { code: "ENOENT" });
    const spawnFn = (() => fakeChild({ error: err })) as never;
    await expect(startHostPty({ claudeBin: "/opt/claude", spawnFn, tmp })).rejects.toBeInstanceOf(
      PtyUnavailable,
    );
    expect(await import("node:fs/promises").then((f) => f.readdir(tmp))).toEqual([]);
    await rm(tmp, { recursive: true, force: true });
  });

  it("streams UTF-8 split across chunks, buffers until onData, and passes writes to stdin", async () => {
    let child!: ReturnType<typeof fakeChild>;
    const run = await startHostPty({
      claudeBin: "/opt/claude",
      spawnFn: (() => (child = fakeChild())) as never,
    });
    const check = Buffer.from("✓ ok");
    child.stdout.write(check.subarray(0, 2));
    await new Promise((r) => setImmediate(r));
    const got: string[] = [];
    run.onData((s) => got.push(s));
    child.stdout.write(check.subarray(2));
    const written: string[] = [];
    child.stdin.on("data", (d: Buffer) => written.push(d.toString()));
    run.write("abc\r");
    await new Promise((r) => setImmediate(r));
    expect(got.join("")).toBe("✓ ok");
    expect(written.join("")).toBe("abc\r");
    run.kill();
    expect(await run.exit).toEqual({ code: 1 });
  });

  it("kill escalates: stdin closed, SIGTERM after 1 s, SIGKILL after 2 more; idempotent", async () => {
    let child!: ReturnType<typeof fakeChild>;
    const run = await startHostPty({
      claudeBin: "/opt/claude",
      spawnFn: (() => {
        child = fakeChild({ exitOnKill: false });
        child.stdin.removeAllListeners("finish"); // a bridge that ignores stdin EOF
        return child;
      }) as never,
    });
    const t0 = Date.now();
    run.kill();
    run.kill();
    expect(child.stdin.writableEnded).toBe(true);
    await new Promise((r) => setTimeout(r, 1_200));
    expect(child.kills).toEqual(["SIGTERM"]);
    await new Promise((r) => setTimeout(r, 2_000));
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(3_000);
    child.stdout.end();
    child.stderr.end();
    child.stdio[3]?.end();
    child.emit("close", null, "SIGKILL");
    expect(await run.exit).toEqual({ code: null });
    run.kill();
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("drains the bridge's stderr and never forwards it", async () => {
    const MARK = "BRIDGE-STDERR-MARKER";
    let child!: ReturnType<typeof fakeChild>;
    const got: string[] = [];
    const run = await startHostPty({
      claudeBin: "/opt/claude",
      spawnFn: (() => (child = fakeChild({ stderr: MARK }))) as never,
    });
    run.onData((s) => got.push(s));
    await new Promise((r) => setImmediate(r));
    expect(child.stderr.readableFlowing).toBe(true);
    child.stderr.write(`${MARK}\n`);
    child.stdout.write("screen");
    await new Promise((r) => setImmediate(r));
    run.kill();
    const exit = await run.exit;
    expect(got.join("")).toBe("screen");
    expect(JSON.stringify(exit)).not.toContain(MARK);
  });
});

describe("probePython", () => {
  const probeChild = (code: number | null, never = false) => {
    const c = new EventEmitter() as EventEmitter & {
      kill(sig?: string): boolean;
      killed: string[];
    };
    c.killed = [];
    c.kill = (sig = "SIGTERM") => {
      c.killed.push(sig);
      setImmediate(() => c.emit("close", null, sig));
      return true;
    };
    if (!never) setImmediate(() => c.emit("close", code, null));
    return c;
  };

  it("runs python3 -I -S -c 'import pty' and a zero exit is available", async () => {
    const calls: unknown[][] = [];
    const ok = await probePython(((...a: unknown[]) => {
      calls.push(a);
      return probeChild(0);
    }) as never);
    expect(ok).toBe(true);
    expect(calls[0]?.[0]).toBe("python3");
    expect(calls[0]?.[1]).toEqual(["-I", "-S", "-c", "import pty"]);
  });

  it("non-zero exit and a 5 s timeout are unavailable", async () => {
    expect(await probePython((() => probeChild(1)) as never)).toBe(false);
    const errChild = new EventEmitter();
    setImmediate(() => errChild.emit("error", Object.assign(new Error("x"), { code: "ENOENT" })));
    expect(await probePython((() => errChild) as never)).toBe(false);
    const slow = probeChild(null, true);
    const t0 = Date.now();
    expect(await probePython((() => slow) as never)).toBe(false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4_900);
    expect(slow.killed).toEqual(["SIGKILL"]);
  }, 10_000);
});

describe("sweepStaleDirs", () => {
  it("removes only own, real, old of-sign-in-* dirs", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "of-sweep-test-"));
    const elsewhere = await mkdtemp(path.join(tmpdir(), "of-sweep-target-"));
    onTestFinished(async () => {
      await rm(parent, { recursive: true, force: true });
      await rm(elsewhere, { recursive: true, force: true });
    });
    const now = Date.now();
    const old = new Date(now - 16 * 60_000);
    const mk = async (p: string, t: Date) => {
      await mkdir(p, { recursive: true });
      await utimes(p, t, t);
    };
    const oldOwn = path.join(parent, "of-sign-in-old");
    await mk(path.join(oldOwn, "inner"), old);
    await utimes(oldOwn, old, old);
    const target = path.join(elsewhere, "of-sign-in-target");
    await mk(target, old);
    const link = path.join(parent, "of-sign-in-link");
    await symlink(target, link);
    const fresh = path.join(parent, "of-sign-in-fresh");
    await mk(fresh, new Date(now - 5 * 60_000));
    const otherName = path.join(parent, "xof-sign-in-y");
    await mk(otherName, old);
    const nested = path.join(parent, "sub", "of-sign-in-nested");
    await mk(nested, old);
    await utimes(path.join(parent, "sub"), old, old);
    const uid = process.getuid?.() ?? 0;

    await sweepStaleDirs(parent, now, uid + 1); // not ours: all left alone
    await expect(lstat(oldOwn)).resolves.toBeTruthy();

    await sweepStaleDirs(parent, now, uid);
    await expect(lstat(oldOwn)).rejects.toThrow();
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    await expect(lstat(target)).resolves.toBeTruthy();
    await expect(lstat(fresh)).resolves.toBeTruthy();
    await expect(lstat(otherName)).resolves.toBeTruthy();
    await expect(lstat(nested)).resolves.toBeTruthy();
  });
});

const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
};
const waitGone = async (pid: number) => {
  for (let i = 0; i < 60 && !gone(pid); i++) await new Promise((r) => setTimeout(r, 50));
  return gone(pid);
};

describe.skipIf(!hasPython && !process.env.CI)("real bridge with the fake CLI", () => {
  const fake = createFakeClaude({ scenario: "reply" });
  // Survives the terminal hanging up, so only a deliberate group kill stops it.
  const stubborn = createFakeClaude({ scenario: "reply", env: { FAKE_CLAUDE_STUBBORN: "1" } });
  const started: number[] = [];

  afterAll(async () => {
    for (const pid of started) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    await rm(fake.dir, { recursive: true, force: true });
    await rm(stubborn.dir, { recursive: true, force: true });
  });

  const waitPrompt = (onData: (cb: (s: string) => void) => void) => {
    let screen = "";
    return new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no prompt")), 10_000);
      onData((s) => {
        screen += s;
        if (screen.includes("Paste code here")) {
          clearTimeout(t);
          resolve(screen);
        }
      });
    });
  };
  const cliPidOf = async (f: typeof fake) => {
    const cliPid = Number(await readFile(path.join(f.dir, "setup-token.pid"), "utf8"));
    started.push(cliPid);
    expect(gone(cliPid)).toBe(false);
    return cliPid;
  };

  /** Starts the real bridge on a fake, waits for the prompt, returns the run, bridge and CLI pid. */
  const begin = async (f = fake) => {
    await rm(path.join(f.dir, "setup-token.pid"), { force: true });
    let bridge: ChildProcess | undefined;
    const spawnFn = ((...a: Parameters<typeof spawn>) => {
      bridge = spawn(...a);
      return bridge;
    }) as typeof spawn;
    const run = await startHostPty({
      claudeBin: f.bin,
      serverEnv: { PATH: process.env.PATH },
      spawnFn,
    });
    onTestFinished(() => rm(run.dir, { recursive: true, force: true })); // only if a test failed
    const screen = await waitPrompt((cb) => run.onData(cb));
    return { run, bridgePid: bridge?.pid as number, cliPid: await cliPidOf(f), screen };
  };

  it("fails in CI without python3", () => {
    if (process.env.CI) expect(hasPython).toBe(true);
  });

  it("the CLI sees a 200-column window, and a code gets the token through", async () => {
    const { run, screen, cliPid } = await begin();
    // the fake cuts the URL to columns - 1, so a 199-character cut proves the window
    // OSC 8 link: ESC ]8;; <url> ESC \ <visible text> ESC ]8;; ESC \
    const shown = screen.split("\x1b]8;;")[1]?.split("\x1b\\")[1];
    expect(shown).toHaveLength(199);
    let out = "";
    run.onData((s) => {
      out += s;
    });
    run.write("SYNTHETIC-CODE-1234");
    await new Promise((r) => setTimeout(r, 150));
    run.write("\r");
    expect(await run.exit).toEqual({ code: 0 });
    expect(out).toContain("sk-ant-oat01-SYNTHETIC");
    expect(await waitGone(cliPid)).toBe(true);
    await expect(stat(run.dir)).rejects.toThrow();
  });

  it("the bridge alone kills the CLI's group on SIGTERM (no transport fallback involved)", async () => {
    await rm(path.join(stubborn.dir, "setup-token.pid"), { force: true });
    const dir = await mkdtemp(path.join(tmpdir(), "of-test-bridge-"));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    const bridge = spawn("python3", bridgeSpawnArgs(stubborn.bin), {
      env: bridgeEnv({ PATH: process.env.PATH }, dir),
      stdio: ["pipe", "pipe", "ignore", "pipe"],
    });
    const closed = new Promise((r) => bridge.once("close", r));
    await waitPrompt((cb) => bridge.stdout?.on("data", (b: Buffer) => cb(b.toString())));
    const cliPid = await cliPidOf(stubborn);
    bridge.kill("SIGTERM");
    await closed;
    expect(await waitGone(cliPid)).toBe(true);
  });

  it("stdin EOF, SIGTERM and SIGINT leave no CLI", async () => {
    for (const how of ["eof", "SIGTERM", "SIGINT"] as const) {
      const { run, bridgePid, cliPid } = await begin(stubborn);
      if (how === "eof") run.kill();
      else process.kill(bridgePid, how);
      expect(await run.exit).toEqual({ code: 1 });
      expect(await waitGone(cliPid)).toBe(true);
      await expect(stat(run.dir)).rejects.toThrow();
    }
  });

  it("SIGKILL of the bridge, then the transport fallback, leaves no CLI", async () => {
    const { run, bridgePid, cliPid } = await begin(stubborn);
    process.kill(bridgePid, "SIGKILL");
    run.kill();
    expect(await run.exit).toEqual({ code: null });
    expect(await waitGone(cliPid)).toBe(true);
    expect(await waitGone(bridgePid)).toBe(true);
    await expect(stat(run.dir)).rejects.toThrow();
  });
});
