import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RuntimeJournal } from "@open-factory/db";

const run = promisify(execFile);

/** One row of `ps -A -o pid=,ppid=,lstart=`. `start` is the start time, whitespace-normalized. */
export interface PsRow {
  pid: number;
  ppid: number;
  start: string;
}

type JournaledPid = { pid: number; start: string };

/** The wait between SIGTERM and SIGKILL (spec §12). */
const REAP_WAIT_MS = 3_000;
/** A C locale keeps `lstart` in one format between the snapshot and the reap. */
const PS_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" };
/** `ps` runs inside the agent's job: a hung one must not block the agent. */
const PS_TIMEOUT_MS = 5_000;

/** `lstart` pads single-digit days ("Nov  9"); collapse runs of whitespace so the comparison is exact. */
const norm = (s: string) => s.trim().replace(/\s+/g, " ");

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\S.*?)\s*$/;

export function parsePs(out: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of out.split("\n")) {
    const m = PS_LINE.exec(line);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), start: norm(m[3] ?? "") });
  }
  return rows;
}

/**
 * Every process under `root` (not `root` itself), breadth first, by parent pid. `setsid` children keep their
 * parent, so they are found; one whose parent already exited was reparented and is only in an earlier snapshot.
 */
export function descendants(rows: PsRow[], root: number): PsRow[] {
  const byParent = new Map<number, PsRow[]>();
  for (const r of rows) {
    const list = byParent.get(r.ppid);
    if (list) list.push(r);
    else byParent.set(r.ppid, [r]);
  }
  const out: PsRow[] = [];
  const seen = new Set<number>([root]);
  const queue = [root];
  for (let pid = queue.shift(); pid !== undefined; pid = queue.shift()) {
    for (const child of byParent.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

/** A pid we may ever signal: a real process, never init, never a process group, never the server itself. */
const signallable = (p: JournaledPid) =>
  Number.isSafeInteger(p.pid) && p.pid > 1 && p.pid !== process.pid && p.start.length > 0;

async function defaultPs(): Promise<string> {
  const { stdout } = await run("ps", ["-A", "-o", "pid=,ppid=,lstart="], {
    env: PS_ENV,
    timeout: PS_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

/** The pid's start time, or undefined when it is gone or `ps` failed (then nothing is signalled: fail closed). */
async function defaultStartOf(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await run("ps", ["-o", "lstart=", "-p", String(pid)], {
      env: PS_ENV,
      timeout: PS_TIMEOUT_MS,
    });
    const start = norm(stdout);
    return start || undefined;
  } catch {
    return undefined; // `ps -p` exits 1 for a pid that doesn't exist
  }
}

/**
 * The local runtime's process journal (spec §12): snapshots Claude's process tree with start times, and reaps
 * it, signalling a journaled pid only while its start time still matches (a reused pid is never ours).
 */
export class ProcessJournal {
  private readonly ps: () => Promise<string>;
  private readonly startOf: (pid: number) => Promise<string | undefined>;
  private readonly kill: (pid: number, sig: NodeJS.Signals) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly parentPid: number;

  constructor(
    d: {
      ps?: () => Promise<string>;
      startOf?: (pid: number) => Promise<string | undefined>;
      kill?: (pid: number, sig: NodeJS.Signals) => void;
      sleep?: (ms: number) => Promise<void>;
      /** Claude's expected parent: the server, which spawns it directly (the local transport). */
      parentPid?: number;
    } = {},
  ) {
    this.ps = d.ps ?? defaultPs;
    this.startOf = d.startOf ?? defaultStartOf;
    this.kill = d.kill ?? ((pid, sig) => process.kill(pid, sig));
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.parentPid = d.parentPid ?? process.pid;
  }

  /**
   * Claude and its descendants now. Throws when Claude's pid isn't running, or isn't the server's child: once the
   * server reaped Claude its pid may be reused, and a stranger's tree must never be journaled (so never reaped).
   */
  async snapshot(claudePid: number): Promise<{
    claude: { pid: number; start: string };
    descendants: { pid: number; start: string }[];
  }> {
    const rows = parsePs(await this.ps());
    const claude = rows.find((r) => r.pid === claudePid);
    if (!claude) throw new Error(`process ${claudePid} is not running`);
    if (claude.ppid !== this.parentPid)
      throw new Error(`process ${claudePid} is not the server's child (parent ${claude.ppid})`);
    return {
      claude: { pid: claude.pid, start: claude.start },
      descendants: descendants(rows, claudePid).map(({ pid, start }) => ({ pid, start })),
    };
  }

  /** SIGTERM every journaled pid whose start time still matches; 3 s; SIGKILL survivors that still match. Returns how many were signalled. */
  async reap(j: Pick<RuntimeJournal, "claude" | "descendants">): Promise<number> {
    const seen = new Set<number>();
    const journaled = [...(j.claude ? [j.claude] : []), ...(j.descendants ?? [])].filter((p) => {
      if (!signallable(p) || seen.has(p.pid)) return false;
      seen.add(p.pid);
      return true;
    });
    const signalled: JournaledPid[] = [];
    for (const p of journaled)
      if (await this.matches(p)) if (this.signal(p.pid, "SIGTERM")) signalled.push(p);
    if (!signalled.length) return 0;
    await this.sleep(REAP_WAIT_MS);
    for (const p of signalled) if (await this.matches(p)) this.signal(p.pid, "SIGKILL");
    return signalled.length;
  }

  private async matches(p: JournaledPid): Promise<boolean> {
    const now = await this.startOf(p.pid);
    return now !== undefined && norm(now) === norm(p.start);
  }

  /** False when the process is already gone (or not ours to signal). */
  private signal(pid: number, sig: NodeJS.Signals): boolean {
    try {
      this.kill(pid, sig);
      return true;
    } catch {
      return false;
    }
  }
}
