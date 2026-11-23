import { spawn } from "node:child_process";
import { chmod, lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PTY_BRIDGE } from "./pty-bridge.ts";

// Spec §5.2. Nothing in this file logs: the bridge's output can carry the sign-in URL, code and token.

export interface PtyRun {
  /** Decoded UTF-8 from the CLI's terminal. Output that arrives before the first callback is held for it. */
  onData(cb: (chunk: string) => void): void;
  write(s: string): void;
  /** Idempotent: close stdin, SIGTERM the bridge after 1 s, then SIGKILL it and the CLI's group 2 s later. */
  kill(): void;
  /** Settles once the bridge has closed and the temp dir is removed. */
  readonly exit: Promise<{ code: number | null }>;
  readonly dir: string;
}

export class PtyUnavailable extends Error {}

const DIR_PREFIX = "of-sign-in-";
const STALE_MS = 15 * 60_000;
const PROBE_MS = 5_000;

export function bridgeSpawnArgs(claudeBin: string): string[] {
  return ["-I", "-S", "-c", PTY_BRIDGE, claudeBin, "setup-token"];
}

/** An allow-list, never the server env: no factory secret or Claude credential reaches the CLI. */
export function bridgeEnv(serverEnv: NodeJS.ProcessEnv, dir: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (serverEnv.PATH) env.PATH = serverEnv.PATH;
  if (serverEnv.LANG) env.LANG = serverEnv.LANG;
  return {
    ...env,
    TERM: "xterm-256color",
    HOME: dir,
    CLAUDE_CONFIG_DIR: dir,
    BROWSER: "true",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "",
    CLAUDE_CODE_OAUTH_TOKEN: "",
  };
}

const killGroup = (pid: number | undefined) => {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
};

export async function startHostPty(d: {
  claudeBin: string;
  serverEnv?: NodeJS.ProcessEnv;
  spawnFn?: typeof spawn;
  tmp?: string;
}): Promise<PtyRun> {
  const dir = await mkdtemp(path.join(d.tmp ?? tmpdir(), DIR_PREFIX));
  await chmod(dir, 0o700);
  const removeDir = () => rm(dir, { recursive: true, force: true });

  const child = (d.spawnFn ?? spawn)("python3", bridgeSpawnArgs(d.claudeBin), {
    env: bridgeEnv(d.serverEnv ?? process.env, dir),
    detached: true,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } catch (e) {
    await removeDir();
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new PtyUnavailable();
    throw e;
  }
  child.on("error", () => {}); // a failed signal to a gone bridge is not an error
  child.stdin?.on("error", () => {}); // EPIPE once the bridge is gone

  child.stderr?.resume(); // drained and dropped, never read

  let cliPid: number | undefined;
  let pidLine = "";
  const pidPipe = child.stdio[3];
  pidPipe?.on("error", () => {});
  pidPipe?.on("data", (b: Buffer) => {
    if (cliPid !== undefined || pidLine.length > 32) return;
    pidLine += b.toString("latin1");
    const nl = pidLine.indexOf("\n");
    if (nl >= 0 && /^\d+$/.test(pidLine.slice(0, nl))) cliPid = Number(pidLine.slice(0, nl));
  });

  const decoder = new TextDecoder("utf-8", { fatal: false });
  const listeners: ((chunk: string) => void)[] = [];
  const held: string[] = [];
  const emit = (s: string) => {
    if (!s) return;
    if (listeners.length === 0) held.push(s);
    else for (const cb of listeners) cb(s);
  };
  child.stdout?.on("data", (b: Buffer) => emit(decoder.decode(b, { stream: true })));

  let closed = false;
  let killing = false;
  const timers: NodeJS.Timeout[] = [];
  const exit = new Promise<{ code: number | null }>((resolve) => {
    child.once("close", (code: number | null) => {
      closed = true;
      for (const t of timers) clearTimeout(t);
      emit(decoder.decode());
      // The bridge kills the CLI's group on every exit it controls; this covers the one it can't
      // (SIGKILL of the bridge). Done now, while the group can't have been reused, never later.
      killGroup(cliPid);
      void removeDir().then(() => resolve({ code }));
    });
  });

  return {
    dir,
    exit,
    onData(cb) {
      listeners.push(cb);
      if (listeners.length === 1) for (const s of held.splice(0)) cb(s);
    },
    write(s) {
      if (!closed && child.stdin?.writable) child.stdin.write(s);
    },
    kill() {
      if (closed || killing) return;
      killing = true;
      child.stdin?.end();
      timers.push(
        setTimeout(() => {
          child.kill("SIGTERM");
          timers.push(
            setTimeout(() => {
              child.kill("SIGKILL");
              killGroup(cliPid);
            }, 2_000),
          );
        }, 1_000),
      );
    },
  };
}

/** `python3 -I -S -c "import pty"` within 5 s. The caller caches the answer for the process. */
export function probePython(spawnFn: typeof spawn = spawn): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const child = spawnFn("python3", ["-I", "-S", "-c", "import pty"], {
      env: process.env.PATH ? { PATH: process.env.PATH } : {},
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, PROBE_MS);
    child.once("error", () => finish(false));
    child.once("close", (code: number | null) => finish(code === 0));
  });
}

/** Boot cleanup of a crashed server's temp dirs: only direct children of `tmp` named `of-sign-in-*`,
 *  inspected with lstat (a symlink is never followed), owned by `uid`, a directory, older than 15 min. */
export async function sweepStaleDirs(
  tmp: string,
  now: number,
  uid = process.getuid?.(),
): Promise<void> {
  if (uid === undefined) return;
  let names: string[];
  try {
    names = await readdir(tmp);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(DIR_PREFIX)) continue;
    const p = path.join(tmp, name);
    try {
      const st = await lstat(p);
      if (st.isDirectory() && st.uid === uid && now - st.mtimeMs > STALE_MS)
        await rm(p, { recursive: true, force: true });
    } catch {}
  }
}
