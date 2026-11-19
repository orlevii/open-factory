import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import {
  AsyncQueue,
  ProcessNotRunningError,
  type Transport,
  type TransportExit,
  type TransportFactory,
} from "@open-factory/harness";
import type { DockerClient, ExecStream } from "./client.ts";
import type { ContainerManager } from "./containers.ts";

/** Lives in the container's own `/tmp`: `/run/open-factory` is root-owned and not writable by `agent` (V4). */
export const CLAUDE_PID_FILE = "/tmp/open-factory-claude.pid";
/** A fixed script (spec §11.3): the Claude path and its arguments are argv entries (`$0`, `$@`), never interpolated. */
export const CLAUDE_WRAPPER = 'echo $$ > /tmp/open-factory-claude.pid && exec "$0" "$@"';
const AGENT_USER = "agent";
/** `/proc/<pid>/comm` of the process terminate may signal (the fake claude sets `process.title` to match). */
const CLAUDE_COMM = "claude";
/** terminate never hangs a stop on a daemon that doesn't answer: past this it reports failure. */
export const TERMINATE_BOUND_MS = 5_000;

/** A positive pid of at most 10 digits, nothing else (fails closed on anything the agent could have written). */
export function parsePid(s: string): number | undefined {
  const t = s.trim();
  return /^[1-9][0-9]{0,9}$/.test(t) ? Number(t) : undefined;
}

const lines = (input: Readable, queue: AsyncQueue<string>) =>
  new Promise<void>((resolve) => {
    const rl = createInterface({ input });
    rl.on("line", (l) => queue.push(l));
    rl.on("close", resolve);
    // A stream error must not crash the server; closing still lets `exit` settle.
    rl.on("error", () => rl.close());
  });

/**
 * Claude in the agent's container through one hijacked `docker exec -i -u agent -w <workdir>` (spec §11.3).
 * Uses `spec.docker.containerId`, `spec.docker.claudeBin`, `spec.cwd` and `spec.env` (the complete exec env).
 */
export function dockerTransport(d: {
  docker: DockerClient;
  containers: ContainerManager;
}): TransportFactory {
  return (spec, args): Transport => {
    const stdout = new AsyncQueue<string>();
    const stderr = new AsyncQueue<string>();
    let settled = false;
    let inputEnded = false;
    let resolveExit!: (e: TransportExit) => void;
    const exit = new Promise<TransportExit>((r) => {
      resolveExit = r;
    });
    const settle = (e: TransportExit) => {
      if (settled) return;
      settled = true;
      stdout.end();
      stderr.end();
      resolveExit(e);
    };

    const container = spec.docker;
    const started: Promise<ExecStream | undefined> = container
      ? d.docker
          .execStream(container.containerId, {
            cmd: ["sh", "-c", CLAUDE_WRAPPER, container.claudeBin, ...args],
            user: AGENT_USER,
            workdir: spec.cwd,
            env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
          })
          .then(
            (s) => {
              s.stdin.on("error", () => {});
              // Every line is queued before `exit` resolves (readline closes on the demuxed stream's end).
              void Promise.all([lines(s.stdout, stdout), lines(s.stderr, stderr), s.exit]).then(
                ([, , code]) => settle({ code, signal: null }),
              );
              return s;
            },
            (err: unknown) => {
              settle({
                code: null,
                signal: null,
                spawnError: { message: err instanceof Error ? err.message : String(err) },
              });
              return undefined;
            },
          )
      : Promise.resolve().then(() => {
          settle({
            code: null,
            signal: null,
            spawnError: { message: "No container was prepared for this Docker start." },
          });
          return undefined;
        });

    const run = (cmd: string[]) => {
      if (!container) throw new Error("no container");
      return d.docker.execRun(container.containerId, { cmd, user: AGENT_USER });
    };

    /**
     * cat the pid file, parse it strictly, require comm == claude, then `kill -TERM` as agent. Argv only.
     * Trust boundary: the pid file and comm are agent-controlled. A forged value can only make the factory SIGTERM
     * another `agent`-owned process in this same container (own pid namespace, no root); the stop then times out
     * and falls back to the container stop.
     * `live()` turns false once terminate's bound has passed, so a late-answering daemon gets no further exec.
     */
    const signalClaude = async (live: () => boolean): Promise<boolean> => {
      const s = await started;
      if (!s || settled || !live()) return false;
      const pid = parsePid((await run(["cat", CLAUDE_PID_FILE])).stdout);
      if (!pid || !live()) return false;
      const comm = (await run(["cat", `/proc/${pid}/comm`])).stdout.trim();
      if (comm !== CLAUDE_COMM || !live()) return false;
      return (await run(["kill", "-TERM", String(pid)])).code === 0;
    };

    return {
      // The pid inside the container means nothing on the host.
      pid: undefined,
      async write(line) {
        const s = inputEnded || settled ? undefined : await started;
        if (!s || settled || inputEnded || s.stdin.writableEnded || s.stdin.destroyed)
          throw new ProcessNotRunningError();
        return new Promise<void>((resolve, reject) =>
          s.stdin.write(`${line}\n`, (err) => (err ? reject(err) : resolve())),
        );
      },
      endInput() {
        if (inputEnded) return;
        inputEnded = true;
        void started.then((s) => s?.closeStdin());
      },
      stdout,
      stderr,
      exit,
      async terminate() {
        if (settled) return false;
        // The whole body is bounded, including waiting for the exec to start: a daemon that never answers
        // can't hang the stop (spec §9.6 escalation runs after termWaitMs).
        let expired = false;
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<boolean>((r) => {
          timer = setTimeout(() => {
            expired = true;
            r(false);
          }, TERMINATE_BOUND_MS);
        });
        try {
          return await Promise.race([signalClaude(() => !expired), timeout]);
        } catch {
          return false;
        } finally {
          clearTimeout(timer);
        }
      },
      async forceKill() {
        // Exited already: the container may be running this agent's next process.
        if (settled) return;
        // `container.stop({t: 5})`: Docker SIGTERMs tini, and the namespace goes with it (V8).
        await d.containers.stop(spec.agentId, spec.slug);
      },
    };
  };
}
