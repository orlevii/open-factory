import { createInterface } from "node:readline";
import { Writable } from "node:stream";

/** Input ended (Ctrl+D, short piped stdin) before a prompt was answered. */
export class PromptAborted extends Error {
  constructor() {
    super("Aborted");
  }
}

export interface Prompt {
  ask(q: string, def?: string): Promise<string>;
  askHidden(q: string): Promise<string>;
  close(): void;
}

/**
 * One readline interface per process (separate interfaces on a piped stdin lose buffered
 * lines). Every question settles: if the input closes first, it rejects with PromptAborted.
 */
export function createPrompt(
  input: NodeJS.ReadableStream & { isTTY?: boolean },
  out: NodeJS.WritableStream,
  onInterrupt?: () => void,
): Prompt {
  let muted = false;
  let closed = false;
  let waiter: { resolve(line: string): void; reject(e: Error): void } | undefined;
  const output = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) out.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input, output, terminal: Boolean(input.isTTY) });
  // Lines are queued rather than read with rl.question(): a piped stdin delivers several lines in
  // one chunk, and readline drops any line that arrives while no question is pending.
  const lines: string[] = [];
  rl.on("line", (line) => {
    if (waiter) {
      const w = waiter;
      waiter = undefined;
      w.resolve(line);
    } else lines.push(line);
  });
  rl.on("close", () => {
    closed = true;
    waiter?.reject(new PromptAborted());
    waiter = undefined;
  });
  if (onInterrupt) rl.on("SIGINT", onInterrupt);

  const question = (text: string) =>
    new Promise<string>((resolve, reject) => {
      rl.setPrompt(text);
      if (!closed) rl.prompt();
      const next = lines.shift();
      if (next !== undefined) return resolve(next);
      if (closed) return reject(new PromptAborted());
      waiter = { resolve, reject };
    });

  return {
    async ask(q, def) {
      const a = await question(def ? `${q} (${def}): ` : `${q}: `);
      return a.trim() || def || "";
    },
    // Hidden input: the prompt is written, then readline's echo is muted until Enter.
    async askHidden(q) {
      const answer = question(`${q}: `);
      muted = true;
      try {
        return await answer;
      } finally {
        muted = false;
        out.write("\n");
      }
    },
    close() {
      if (!closed) rl.close();
    },
  };
}

// Real terminal prompt, created on first use so commands that never prompt don't touch stdin.
let stdio: Prompt | undefined;
const terminal = (): Prompt => {
  stdio ??= createPrompt(process.stdin, process.stdout, () => {
    // Ctrl+C at a prompt: restore the terminal and exit like a normal interrupt.
    stdio?.close();
    process.stdout.write("\n");
    process.exit(130);
  });
  return stdio;
};

export const ask = (q: string, def?: string) => terminal().ask(q, def);
export const askHidden = (q: string) => terminal().askHidden(q);
export const closePrompt = () => stdio?.close();
