export interface ShutdownOptions {
  exit: (code: number) => void;
  log: (message: string) => void;
  /** Force exit(1) if the steps haven't finished by then. */
  timeoutMs?: number;
}

/**
 * Returns a signal handler that runs each close step once, in order. A failing step is logged and
 * the rest still run; a hung step is cut off by a force-exit timer.
 */
export function createShutdown(
  steps: Array<() => Promise<unknown>>,
  // 20 s: agent processes get stdin close + 3 s + SIGTERM + up to 10 s (spec §8.1). Exiting earlier would
  // leave Claude running on stdin EOF, and the next boot would --resume the same session concurrently.
  { exit, log, timeoutMs = 20_000 }: ShutdownOptions,
) {
  let started = false;
  return async () => {
    if (started) return;
    started = true;
    const timer = setTimeout(() => {
      log(`Shutdown did not finish within ${timeoutMs / 1000}s; forcing exit`);
      exit(1);
    }, timeoutMs);
    timer.unref?.();
    let code = 0;
    try {
      for (const step of steps) {
        try {
          await step();
        } catch (e) {
          code = 1;
          log(`Error during shutdown: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } finally {
      clearTimeout(timer);
      exit(code);
    }
  };
}
