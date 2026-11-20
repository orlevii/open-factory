import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { LABEL_BUILT_AT, LABEL_CONTEXT_HASH, userImageTag } from "@open-factory/shared";
import type { RuntimeLog } from "../agents/agent-runtime.ts";
import type { EventBus } from "../agents/event-bus.ts";
import type { DockerClient } from "../runtime/docker/client.ts";
import { hashEntries, imageDir, packEntries, walkContext } from "./context.ts";

export type BuildResult = { state: "succeeded" } | { state: "failed"; error: string };
export type LastBuild = {
  state: "succeeded" | "failed";
  finishedAt: Date;
  error?: string;
  durationMs: number;
};

/** The frame batching window (spec §10.3). */
const BATCH_MS = 250;
/** Lines kept per name once a build is over (spec §10.3). */
const KEEP_LINES = 200;

interface Run {
  promise: Promise<BuildResult>;
  pull: boolean;
  lines: string[];
  pending: string[];
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** The images a Dockerfile builds `FROM`, skipping earlier stages, `scratch` and refs built from `ARG`s. */
export function fromRefs(dockerfile: string): string[] {
  const stages = new Set<string>();
  const refs: string[] = [];
  for (const line of dockerfile.split(/\r?\n/)) {
    const m = /^\s*FROM\s+(.+)$/i.exec(line);
    if (!m?.[1]) continue;
    const [ref, as, alias] = m[1]
      .trim()
      .split(/\s+/)
      .filter((w) => !w.startsWith("--"));
    if (
      ref &&
      !stages.has(ref.toLowerCase()) &&
      ref.toLowerCase() !== "scratch" &&
      !ref.includes("$") &&
      !refs.includes(ref)
    )
      refs.push(ref);
    if (as?.toLowerCase() === "as" && alias) stages.add(alias.toLowerCase());
  }
  return refs;
}

/** A reference without its tag or digest, as Docker names it in "pull access denied for <repo>". */
const repoOf = (ref: string) => {
  const noDigest = ref.split("@")[0] ?? ref;
  const colon = noDigest.lastIndexOf(":");
  return colon > noDigest.lastIndexOf("/") ? noDigest.slice(0, colon) : noDigest;
};

/** Live gate V1 (c): a base that can't be pulled gets the `--no-pull` hint (spec §10.3, F3). */
export function buildError(error: string, name: string, refs: string[]): string {
  const denied = /pull access denied for ([^\s,]+)/.exec(error);
  if (!denied?.[1]) return error;
  const repo = denied[1];
  const ref = refs.find((r) => repoOf(r) === repo) ?? refs[0] ?? repo;
  return `Base image ${ref} couldn't be pulled. If it's local-only, run \`open-factory images build ${name} --no-pull\`.`;
}

/**
 * Builds user images (spec §10.3): one build per name at a time, the running build's log streamed, and the last
 * result per name kept in memory until the next build or a restart (Q13: no table).
 */
export class ImageBuilder {
  private readonly runs = new Map<string, Run>();
  private readonly lasts = new Map<string, LastBuild & { lines: string[] }>();
  private readonly listeners = new Map<string, Set<(line: string) => void>>();

  constructor(
    private readonly d: {
      docker: DockerClient;
      imagesRoot: string;
      bus: EventBus;
      now: () => Date;
      log: RuntimeLog;
    },
  ) {}

  /** Joins a running build of the same name. Rejects with `ImageNameError` for a bad name; never for a failed build. */
  async build(name: string, o: { pull: boolean }): Promise<BuildResult> {
    const started = this.d.now();
    const running = this.runs.get(name);
    if (running) return running.promise;
    const dir = await imageDir(this.d.imagesRoot, name);
    const raced = this.runs.get(name);
    if (raced) return raced.promise;

    const run: Run = {
      promise: Promise.resolve({ state: "succeeded" }),
      pull: o.pull,
      lines: [],
      pending: [],
      timer: undefined,
    };
    this.runs.set(name, run);
    this.d.bus.publishAll({ type: "image_build", name, state: "building" });
    run.promise = this.execute(name, dir, o.pull, started, run).then((result) =>
      this.finish(name, run, started, result),
    );
    return run.promise;
  }

  running(name: string): boolean {
    return this.runs.has(name);
  }

  /** The running build's `pull`, so a caller that joins it with a different one can be told. */
  runningPull(name: string): boolean | undefined {
    return this.runs.get(name)?.pull;
  }

  log(name: string): { state: "building" | "succeeded" | "failed" | null; lines: string[] } {
    const run = this.runs.get(name);
    if (run) return { state: "building", lines: [...run.lines] };
    const last = this.lasts.get(name);
    return last ? { state: last.state, lines: [...last.lines] } : { state: null, lines: [] };
  }

  last(name: string): LastBuild | undefined {
    const last = this.lasts.get(name);
    if (!last) return undefined;
    const { lines: _lines, ...rest } = last;
    return rest;
  }

  /**
   * Every further build output line for the name (the ndjson stream's source), until unsubscribed. Subscribing
   * right after `build()` misses nothing: the build's first line comes after its first await.
   */
  subscribe(name: string, fn: (line: string) => void): () => void {
    const set = this.listeners.get(name) ?? new Set();
    this.listeners.set(name, set);
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0 && this.listeners.get(name) === set) this.listeners.delete(name);
    };
  }

  private async execute(
    name: string,
    dir: string,
    pull: boolean,
    started: Date,
    run: Run,
  ): Promise<BuildResult> {
    const tag = userImageTag(name);
    const onLine = (line: string) => this.line(name, run, line);
    let context: Readable | undefined;
    try {
      const refs = fromRefs(await readFile(join(dir, "Dockerfile"), "utf8").catch(() => ""));
      // One walk: the label's hash and the tar cover the same entries, and the pack checks each file is
      // still the one the walk saw.
      const entries = await walkContext(dir, name);
      const hash = await hashEntries(dir, name, entries);
      context = packEntries(dir, name, entries);
      const labels = { [LABEL_CONTEXT_HASH]: hash, [LABEL_BUILT_AT]: started.toISOString() };
      const r = await this.d.docker.buildImage(context, { tag, pull, labels }, onLine);
      if (!r.ok) return { state: "failed", error: buildError(r.error, name, refs) };
      for (const ref of refs) await this.baseLine(ref, onLine);
      return { state: "succeeded" };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      onLine(error);
      return { state: "failed", error };
    } finally {
      // Docker may stop reading early (a failure in the stream); the pack must not wait on it forever.
      context?.destroy();
    }
  }

  /** The base image's registry digests after the pull, so the log names exactly what was built on. */
  private async baseLine(ref: string, onLine: (line: string) => void) {
    try {
      const base = await this.d.docker.imageInspect(ref);
      if (!base) return;
      const what = base.repoDigests.length
        ? base.repoDigests.join(", ")
        : `${base.id} (no registry digest)`;
      onLine(`Base image ${ref}: ${what}`);
    } catch {
      // The build succeeded; a missing digest line is not worth failing it.
    }
  }

  private line(name: string, run: Run, line: string) {
    run.lines.push(line);
    run.pending.push(line);
    for (const fn of this.listeners.get(name) ?? []) fn(line);
    run.timer ??= setTimeout(() => this.flush(name, run), BATCH_MS);
  }

  private flush(name: string, run: Run) {
    clearTimeout(run.timer);
    run.timer = undefined;
    if (!run.pending.length) return;
    const lines = run.pending;
    run.pending = [];
    this.d.bus.publishAll({ type: "image_build", name, state: "building", lines });
  }

  private finish(name: string, run: Run, started: Date, result: BuildResult): BuildResult {
    const finishedAt = this.d.now();
    try {
      this.flush(name, run);
    } finally {
      // Before anything that can throw: a failed publish must never leave the name building.
      this.lasts.set(name, {
        state: result.state,
        finishedAt,
        ...(result.state === "failed" ? { error: result.error } : {}),
        durationMs: finishedAt.getTime() - started.getTime(),
        lines: run.lines.slice(-KEEP_LINES),
      });
      this.runs.delete(name);
    }
    this.d.log.info({ image: name, state: result.state }, "image build finished");
    this.d.bus.publishAll({ type: "image_build", name, state: result.state });
    this.d.bus.publishAll({ type: "images_changed" });
    return result;
  }
}
