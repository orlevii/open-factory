import { type ChildProcess, spawn } from "node:child_process";
import { buildProgress } from "../build-progress.ts";
import type {
  BuildImageResult,
  ContainerCreateOptions,
  ContainerInfo,
  DockerClient,
  ExecStream,
} from "../client.ts";
import { CLAUDE_PID_FILE } from "../exec-transport.ts";

export type Call = { op: string; args: unknown[] };

/** Docker build stream events recorded by live gate V1 (packages/harness/fixtures/README.md). */
export const BUILD_EVENTS = {
  ok: (tag: string): object[] => [
    { stream: "Step 1/2 : FROM ghcr.io/orlevii/open-factory/base:latest\n" },
    { stream: " ---> 5d0da3dc9764\n" },
    { stream: "Step 2/2 : RUN true\n" },
    { stream: `Successfully tagged ${tag}\n` },
  ],
  /** V1 (b): `RUN false`. */
  runFalse: (): object[] => {
    const msg = "The command '/bin/bash -o pipefail -c false' returned a non-zero code: 1";
    return [
      { stream: "Step 2/2 : RUN false\n" },
      { error: msg, errorDetail: { code: 1, message: msg } },
    ];
  },
  /** V1 (c): `FROM open-factory-base:dev` with `pull: true`. */
  pullDenied: (): object[] => {
    const msg =
      "pull access denied for open-factory-base, repository does not exist or may require 'docker login'";
    return [{ error: msg, errorDetail: { message: msg } }];
  },
};

/** One scripted build: its stream events, then (when set) a gate it waits on before finishing. */
export interface FakeBuild {
  events?: object[];
  gate?: Promise<void>;
  /** Called once every scripted event has reached `onLine`. */
  emitted?: () => void;
}

export interface FakeContainer {
  id: string;
  name: string;
  running: boolean;
  labels: Record<string, string>;
  opts: ContainerCreateOptions;
}

/**
 * A Docker daemon in memory that records every call. Containers and images are plain records. `execStream` runs the
 * exec'd command as a local child process (the claude path and its argv after the fixed wrapper script, in the exec's
 * workdir, with exactly the exec's env), and every such child, plus any process `track`ed into a container, dies
 * with SIGKILL when that container stops, as a real container stop kills its namespace (V8).
 */
export class FakeDockerClient implements DockerClient {
  calls: Call[] = [];
  images = new Map<
    string,
    { id: string; labels: Record<string, string>; repoDigests?: string[] }
  >();
  /** Scripted builds, consumed in order; when empty a build succeeds with V1 (a)'s lines. */
  builds: FakeBuild[] = [];
  /** The tar bytes each build received. */
  readonly buildContexts: Buffer[] = [];
  containers = new Map<string, FakeContainer>();
  pullError: Error | undefined;
  /** The signal of every pull, in order. */
  readonly pullSignals: AbortSignal[] = [];
  /** When set, `pull` waits for it. */
  pullGate: Promise<void> | undefined;
  /** When set, every call that reaches the daemon throws it (an unreachable daemon). */
  down: Error | undefined;
  /** When set, `remove` throws it. */
  removeError: Error | undefined;
  /** When set, `stop` throws it. */
  stopError: Error | undefined;
  /** What `test -f /run/open-factory/ready` answers. */
  ready: (c: FakeContainer) => boolean = () => true;
  /** Overrides what `cat <pid file>` answers (the agent can write anything there). */
  pidFile: string | undefined;
  logs = "";
  /** Processes running "in" each container, by container id. */
  readonly procs = new Map<string, Set<ChildProcess>>();
  private seq = 0;

  private rec(op: string, ...args: unknown[]) {
    this.calls.push({ op, args });
    if (this.down) throw this.down;
  }
  ops() {
    return this.calls.map((c) => c.op);
  }
  /** Records a marker in the call log (e.g. when `prepare` ran), for ordering assertions. */
  mark(op: string) {
    this.calls.push({ op, args: [] });
  }
  private byId(id: string) {
    const c = [...this.containers.values()].find((x) => x.id === id);
    if (!c) throw Object.assign(new Error("no such container"), { statusCode: 404 });
    return c;
  }
  private info(c: FakeContainer): ContainerInfo {
    return { id: c.id, running: c.running, labels: c.labels };
  }

  /** A process that runs inside the container (a background `sleep` an agent left). */
  track(containerId: string, child: ChildProcess) {
    let set = this.procs.get(containerId);
    if (!set) {
      set = new Set();
      this.procs.set(containerId, set);
    }
    set.add(child);
    child.on("exit", () => set?.delete(child));
  }
  /** Kills every child this fake started (test teardown). */
  killAll() {
    for (const set of this.procs.values()) for (const c of set) c.kill("SIGKILL");
  }
  /** The live Claude exec children of a container. */
  live(containerId: string): ChildProcess[] {
    return [...(this.procs.get(containerId) ?? [])].filter((c) => c.exitCode === null && !c.killed);
  }

  async imageId(ref: string) {
    this.rec("imageId", ref);
    return this.images.get(ref)?.id;
  }
  async imageInspect(ref: string) {
    this.rec("imageInspect", ref);
    const img = this.images.get(ref);
    return img && { id: img.id, labels: { ...img.labels }, repoDigests: img.repoDigests ?? [] };
  }
  async buildImage(
    context: NodeJS.ReadableStream,
    o: { tag: string; pull: boolean; labels: Record<string, string> },
    onLine: (line: string) => void,
  ): Promise<BuildImageResult> {
    this.rec("buildImage", o);
    const chunks: Buffer[] = [];
    for await (const c of context as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
    this.buildContexts.push(Buffer.concat(chunks));
    const script = this.builds.shift() ?? {};
    const progress = buildProgress(onLine);
    for (const e of script.events ?? BUILD_EVENTS.ok(o.tag)) progress.push(e);
    script.emitted?.();
    if (script.gate) await script.gate;
    const result = progress.end(null);
    if (result.ok)
      this.images.set(o.tag, { id: `sha256:built${++this.seq}`, labels: { ...o.labels } });
    return result;
  }
  async pull(ref: string, _signal: AbortSignal) {
    this.rec("pull", ref);
    this.pullSignals.push(_signal);
    if (this.pullGate) await this.pullGate;
    if (this.pullError) throw this.pullError;
    this.images.set(ref, { id: "sha256:pulled", labels: {} });
  }
  async imageLabel(ref: string, label: string) {
    this.rec("imageLabel", ref, label);
    const img = this.images.get(ref) ?? [...this.images.values()].find((x) => x.id === ref);
    return img?.labels[label];
  }
  async findContainer(name: string) {
    this.rec("findContainer", name);
    const c = this.containers.get(name);
    return c && this.info(c);
  }
  async listByLabel(label: string) {
    this.rec("listByLabel", label);
    return [...this.containers.values()].filter((c) => label in c.labels).map((c) => this.info(c));
  }
  async create(opts: ContainerCreateOptions) {
    this.rec("create", opts);
    const id = `c${++this.seq}`;
    const name = opts.name ?? id;
    this.containers.set(name, { id, name, running: false, labels: opts.Labels ?? {}, opts });
    return id;
  }
  async start(id: string) {
    this.rec("start", id);
    this.byId(id).running = true;
  }
  async stop(id: string, t: number) {
    this.rec("stop", id, t);
    if (this.stopError) throw this.stopError;
    this.byId(id).running = false;
    for (const c of this.procs.get(id) ?? []) c.kill("SIGKILL");
  }
  async remove(id: string, opts?: { force?: boolean }) {
    this.rec("remove", id, opts);
    if (this.removeError) throw this.removeError;
    const c = this.byId(id);
    if (c.running && !opts?.force)
      throw Object.assign(new Error("container is running"), { statusCode: 409 });
    for (const p of this.procs.get(id) ?? []) p.kill("SIGKILL");
    this.containers.delete(c.name);
  }
  async execRun(id: string, o: { cmd: string[]; user: string }) {
    this.rec("execRun", id, o);
    const c = this.byId(id);
    if (!c.running) throw Object.assign(new Error("container is not running"), { statusCode: 409 });
    const [bin, arg, arg2] = o.cmd;
    const claude = this.live(id)[0];
    if (bin === "cat" && arg === CLAUDE_PID_FILE)
      return { code: 0, stdout: this.pidFile ?? `${claude?.pid ?? ""}\n` };
    if (bin === "cat" && arg?.startsWith("/proc/")) {
      const pid = Number(arg.split("/")[2]);
      return { code: 0, stdout: this.live(id).some((p) => p.pid === pid) ? "claude\n" : "sh\n" };
    }
    if (bin === "kill" && arg === "-TERM") {
      const target = this.live(id).find((p) => p.pid === Number(arg2));
      if (!target) return { code: 1, stdout: "" };
      target.kill("SIGTERM");
      return { code: 0, stdout: "" };
    }
    return { code: this.ready(c) ? 0 : 1, stdout: "" };
  }
  async execStream(
    id: string,
    o: { cmd: string[]; user: string; workdir: string; env: string[] },
  ): Promise<ExecStream> {
    this.rec("execStream", id, o);
    const c = this.byId(id);
    if (!c.running) throw Object.assign(new Error("container is not running"), { statusCode: 409 });
    // cmd = ["sh", "-c", <wrapper>, claudeBin, ...args]: run the claude path with its argv, like the wrapper's exec.
    const [claudeBin, ...args] = o.cmd.slice(3);
    if (!claudeBin) throw new Error("no claude path in the exec");
    const env = Object.fromEntries(
      o.env.map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]),
    );
    const child = spawn(claudeBin, args, { cwd: o.workdir, env, stdio: ["pipe", "pipe", "pipe"] });
    this.track(id, child);
    const { stdin, stdout, stderr } = child;
    if (!stdin || !stdout || !stderr) throw new Error("no stdio");
    const exit = new Promise<number | null>((resolve) => {
      child.on("close", (code) => resolve(code)); // null when killed by a signal, like Docker's "can't tell"
      child.on("error", () => resolve(null));
    });
    return { stdin, stdout, stderr, closeStdin: () => stdin.end(), exit };
  }
  async logsTail(id: string, n: number) {
    this.rec("logsTail", id, n);
    return this.logs;
  }

  bridge: { gateway?: string; subnet?: string } = {};
  async bridgeNetwork() {
    this.rec("bridgeNetwork");
    return this.bridge;
  }
}
