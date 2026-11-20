import { PassThrough, type Readable, type Writable } from "node:stream";
import Docker, { type ContainerCreateOptions } from "dockerode";
import { buildProgress } from "./build-progress.ts";

// The only dockerode import outside tests (spec §4): everything else talks to Docker through `DockerClient`.
export type { ContainerCreateOptions };

export interface ContainerInfo {
  id: string;
  running: boolean;
  labels: Record<string, string>;
}

/** One hijacked exec (spec §11.3): stdin is the raw stream, stdout/stderr are demultiplexed. */
export interface ExecStream {
  /** NDJSON goes here. */
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Half-closes the stream: Claude sees stdin EOF (V2). */
  closeStdin(): void;
  /** Resolves when the stream ends, with the exec's `ExitCode` (null when Docker can't tell). */
  readonly exit: Promise<number | null>;
}

export type BuildImageResult = { ok: true } | { ok: false; error: string };

export interface ImageInspect {
  id: string;
  labels: Record<string, string>;
  repoDigests: string[];
}

export interface DockerClient {
  /** The local image id, undefined when the image isn't present. */
  imageId(ref: string): Promise<string | undefined>;
  /** The local image, undefined when it isn't present. */
  imageInspect(ref: string): Promise<ImageInspect | undefined>;
  /**
   * Builds a tar context (spec §10.3): no build args, no registry auth, no push. Each output line goes to `onLine`;
   * a failure reported in the stream (live gate V1) resolves `{ok: false}`. Rejects only when Docker can't be asked.
   */
  buildImage(
    context: NodeJS.ReadableStream,
    o: { tag: string; pull: boolean; labels: Record<string, string> },
    onLine: (line: string) => void,
  ): Promise<BuildImageResult>;
  /** Rejects with the registry's error verbatim. */
  pull(ref: string, signal: AbortSignal): Promise<void>;
  imageLabel(ref: string, label: string): Promise<string | undefined>;
  /** The container with exactly this name, running or not. */
  findContainer(name: string): Promise<ContainerInfo | undefined>;
  listByLabel(label: string): Promise<ContainerInfo[]>;
  create(opts: ContainerCreateOptions): Promise<string>;
  start(id: string): Promise<void>;
  stop(id: string, t: number): Promise<void>;
  /** `force` kills a running container first (the last resort of spec §9.6). */
  remove(id: string, opts?: { force?: boolean }): Promise<void>;
  execRun(
    id: string,
    o: { cmd: string[]; user: string },
  ): Promise<{ code: number; stdout: string }>;
  execStream(
    id: string,
    o: { cmd: string[]; user: string; workdir: string; env: string[] },
  ): Promise<ExecStream>;
  logsTail(id: string, n: number): Promise<string>;
  /** The default bridge network's first IPAM entry (`GET /networks/bridge`). */
  bridgeNetwork(): Promise<{ gateway?: string; subnet?: string }>;
}

const statusOf = (err: unknown) => (err as { statusCode?: number } | null)?.statusCode;

/** Splits Docker's multiplexed log/exec framing (8-byte header: stream, 0, 0, 0, size BE). */
export function demuxBuffer(buf: Buffer): { stdout: string; stderr: string; all: string } {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  const all: Buffer[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const type = buf[i];
    const size = buf.readUInt32BE(i + 4);
    const chunk = buf.subarray(i + 8, i + 8 + size);
    (type === 2 ? err : out).push(chunk);
    all.push(chunk);
    i += 8 + size;
  }
  const text = (b: Buffer[]) => Buffer.concat(b).toString("utf8");
  return { stdout: text(out), stderr: text(err), all: text(all) };
}

const toInfo = (c: Docker.ContainerInfo): ContainerInfo => ({
  id: c.Id,
  running: c.State === "running",
  labels: c.Labels ?? {},
});

/** The dockerode adapter. Honours `DOCKER_HOST` through dockerode's defaults; no docker CLI on the host. */
export function dockerodeClient(): DockerClient {
  const docker = new Docker();

  const exitCode = async (exec: Docker.Exec): Promise<number | null> => {
    try {
      const info = await exec.inspect();
      return typeof info.ExitCode === "number" ? info.ExitCode : null;
    } catch {
      return null;
    }
  };

  return {
    async imageInspect(ref) {
      try {
        const info = await docker.getImage(ref).inspect();
        return {
          id: info.Id,
          labels: info.Config?.Labels ?? {},
          repoDigests: info.RepoDigests ?? [],
        };
      } catch (err) {
        if (statusOf(err) === 404) return undefined;
        throw err;
      }
    },

    async buildImage(context, o, onLine) {
      // No buildargs, no registry auth, no push (spec §10.3, R8).
      const stream: NodeJS.ReadableStream = await docker.buildImage(context, {
        t: o.tag,
        pull: o.pull,
        labels: o.labels,
        rm: true,
        forcerm: true,
      });
      const progress = buildProgress(onLine);
      return new Promise((resolve) => {
        docker.modem.followProgress(
          stream,
          (err: Error | null) => resolve(progress.end(err)),
          (ev: object) => progress.push(ev),
        );
      });
    },

    async imageId(ref) {
      try {
        return (await docker.getImage(ref).inspect()).Id;
      } catch (err) {
        if (statusOf(err) === 404) return undefined;
        throw err;
      }
    },

    async pull(ref, signal) {
      signal.throwIfAborted();
      const stream: NodeJS.ReadableStream = await docker.pull(ref, { abortSignal: signal });
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          (stream as Readable).destroy?.();
          reject(signal.reason);
        };
        // An abort between the pull request and here would never fire the listener: check first.
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
        docker.modem.followProgress(stream, (err: Error | null) => {
          signal.removeEventListener("abort", onAbort);
          if (signal.aborted) reject(signal.reason);
          else if (err) reject(err);
          else resolve();
        });
      });
    },

    async imageLabel(ref, label) {
      try {
        return (await docker.getImage(ref).inspect()).Config?.Labels?.[label] ?? undefined;
      } catch (err) {
        if (statusOf(err) === 404) return undefined;
        throw err;
      }
    },

    async findContainer(name) {
      // Docker's name filter matches substrings; keep the exact name only.
      const list = await docker.listContainers({ all: true, filters: { name: [name] } });
      const hit = list.find((c) => c.Names.includes(`/${name}`));
      return hit ? toInfo(hit) : undefined;
    },

    async listByLabel(label) {
      return (await docker.listContainers({ all: true, filters: { label: [label] } })).map(toInfo);
    },

    async create(opts) {
      return (await docker.createContainer(opts)).id;
    },

    async start(id) {
      try {
        await docker.getContainer(id).start();
      } catch (err) {
        if (statusOf(err) !== 304) throw err; // already started
      }
    },

    async stop(id, t) {
      try {
        await docker.getContainer(id).stop({ t });
      } catch (err) {
        const code = statusOf(err);
        if (code !== 304 && code !== 404) throw err; // already stopped / gone
      }
    },

    async remove(id, opts) {
      try {
        await docker.getContainer(id).remove({ force: opts?.force ?? false });
      } catch (err) {
        if (statusOf(err) !== 404) throw err;
      }
    },

    async execRun(id, o) {
      const exec = await docker.getContainer(id).exec({
        Cmd: o.cmd,
        User: o.user,
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start({ hijack: true, stdin: false });
      const chunks: Buffer[] = [];
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      stdout.on("data", (c: Buffer) => chunks.push(c));
      stderr.resume();
      docker.modem.demuxStream(stream, stdout, stderr);
      await new Promise<void>((resolve, reject) => {
        stream.on("end", resolve);
        stream.on("close", resolve);
        stream.on("error", reject);
      });
      return { code: (await exitCode(exec)) ?? -1, stdout: Buffer.concat(chunks).toString("utf8") };
    },

    async execStream(id, o) {
      const exec = await docker.getContainer(id).exec({
        Cmd: o.cmd,
        User: o.user,
        WorkingDir: o.workdir,
        Env: o.env,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
      });
      const stream = await exec.start({ hijack: true, stdin: true });
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      docker.modem.demuxStream(stream, stdout, stderr);
      const exit = new Promise<number | null>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          stdout.end();
          stderr.end();
          void exitCode(exec).then(resolve);
        };
        stream.on("end", finish);
        stream.on("close", finish);
        stream.on("error", finish);
      });
      return { stdin: stream, stdout, stderr, closeStdin: () => stream.end(), exit };
    },

    async logsTail(id, n) {
      const buf = await docker
        .getContainer(id)
        .logs({ stdout: true, stderr: true, tail: n, follow: false });
      return demuxBuffer(Buffer.from(buf)).all; // stdout and stderr in the order they were written
    },

    async bridgeNetwork() {
      const info = (await docker.getNetwork("bridge").inspect()) as {
        IPAM?: { Config?: { Gateway?: string; Subnet?: string }[] };
      };
      const cfg = info.IPAM?.Config?.find((c) => c.Gateway && !c.Gateway.includes(":"));
      return { gateway: cfg?.Gateway, subnet: cfg?.Subnet };
    },
  };
}
