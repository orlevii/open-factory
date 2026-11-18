import { createInterface, type Interface } from "node:readline";
import { Writable } from "node:stream";

// Real terminal I/O; not unit-tested (commands take an Io seam instead).
// One shared readline interface: separate interfaces on a piped stdin lose buffered lines.
let muted = false;
let rl: Interface | undefined;

const output = new Writable({
  write(chunk, _enc, cb) {
    if (!muted) process.stdout.write(chunk);
    cb();
  },
});

function iface(): Interface {
  if (!rl) {
    rl = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
    // Ctrl+C at a prompt: restore the terminal and exit like a normal interrupt.
    rl.on("SIGINT", () => {
      closePrompt();
      process.stdout.write("\n");
      process.exit(130);
    });
  }
  return rl;
}

function question(text: string): Promise<string> {
  return new Promise((resolve) => iface().question(text, resolve));
}

export async function ask(q: string, def?: string): Promise<string> {
  const a = await question(def ? `${q} (${def}): ` : `${q}: `);
  return a.trim() || def || "";
}

/** Hidden input: the prompt is written, then readline's echo is muted until Enter. */
export async function askHidden(q: string): Promise<string> {
  const pending = question(`${q}: `);
  muted = true;
  try {
    return await pending;
  } finally {
    muted = false;
    process.stdout.write("\n");
  }
}

export function closePrompt(): void {
  rl?.close();
  rl = undefined;
}
