import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PREFIX = "of-vitest-";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Tests leave read-only folders (the library's GitHub checkouts): make every folder writable, then remove. */
const writable = (dir: string) => {
  chmodSync(dir, 0o700);
  for (const e of readdirSync(dir, { withFileTypes: true }))
    if (e.isDirectory()) writable(path.join(dir, e.name));
};

const remove = (dir: string) => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    writable(dir);
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Every temp file a run makes (tests, fake Claude, git) goes in one folder that the run removes, so the OS
 *  temp dir doesn't keep growing. Workers start after this and inherit TMPDIR. An interrupted run skips the
 *  teardown, so each run also removes the folders of runs whose process is gone. */
export default function setup() {
  const root = tmpdir();
  for (const name of readdirSync(root)) {
    const pid = Number(new RegExp(`^${PREFIX}(\\d+)-`).exec(name)?.[1]);
    if (pid && !alive(pid)) remove(path.join(root, name));
  }
  const dir = mkdtempSync(path.join(root, `${PREFIX}${process.pid}-`));
  process.env.TMPDIR = dir;
  return () => remove(dir);
}
