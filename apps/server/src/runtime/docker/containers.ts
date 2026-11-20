import type { Mount } from "@open-factory/harness";
import type { RuntimeLog } from "../../agents/agent-runtime.ts";
import { AgentStartError } from "../../agents/errors.ts";
import { checkMounts, type MountCheckContext } from "../../workspace/mounts.ts";
import type { ContainerCreateOptions, ContainerInfo, DockerClient } from "./client.ts";
import { containerSpec, specHash } from "./spec-hash.ts";

export { specHash };

export const LABEL_AGENT_ID = "io.open-factory.agent-id";
export const LABEL_SLUG = "io.open-factory.slug";
export const LABEL_SPEC_HASH = "io.open-factory.spec-hash";
export const LABEL_IMAGE_ID = "io.open-factory.image-id";
/** The image reference the agent asked for; the container runs the image by id. */
export const LABEL_IMAGE = "io.open-factory.image";
/** Set by the base image (images/base/Dockerfile). */
export const LABEL_CLAUDE_CODE_VERSION = "io.open-factory.claude-code.version";

/** Spec §5/§11 timings. */
export const STOP_T_SECONDS = 5;
/** A container stop that hasn't answered by then is reported as failed (it never hangs a job). */
export const STOP_BOUND_MS = STOP_T_SECONDS * 1000 + 10_000;
export const READY_POLL_MS = 200;
export const READY_TIMEOUT_MS = 30_000;
export const READY_MARKER = "/run/open-factory/ready";
const LOG_TAIL_LINES = 50;
const LOGS_BOUND_MS = 5_000;
const LIST_BOUND_MS = 10_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Rejects with `message` when `p` hasn't settled within `ms`. */
async function bounded<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([p, bound]);
  } finally {
    clearTimeout(timer);
  }
}

export const ROOT_REFUSED = "The factory runs as root; Docker agents need a non-root host user.";

/** The image went missing after the pull check (removed meanwhile): the next wake must check and pull again. */
export class ImageMissingError extends AgentStartError {
  constructor(readonly image: string) {
    super(`The image ${image} isn't available locally.`);
    this.name = "ImageMissingError";
  }
}

export function containerName(slug: string, agentId: string): string {
  return `open-factory-${slug}-${agentId.slice(0, 8)}`;
}

/**
 * Spec §11.1: the S2 contract plus hardening. `Cmd` is the image default (`sleep infinity`), `Init` is unset (the
 * image's ENTRYPOINT runs tini), the network and pid namespaces are Docker's defaults, and the only mounts are the
 * ones passed in, which `ContainerManager.ensure` takes from `checkMounts` alone. `Image` is the image id that was
 * hashed (a tag retagged meanwhile can't swap it). Everything but the name and the labels comes from
 * `containerSpec`, which is what the spec hash covers.
 */
export function createOptions(i: {
  name: string;
  image: string;
  imageId: string;
  mounts: Mount[];
  uid: number;
  gid: number;
  agentId: string;
  slug: string;
  specHash: string;
}): ContainerCreateOptions {
  return {
    name: i.name,
    ...containerSpec({ imageId: i.imageId, mounts: i.mounts, uid: i.uid, gid: i.gid }),
    Labels: {
      [LABEL_AGENT_ID]: i.agentId,
      [LABEL_SLUG]: i.slug,
      [LABEL_SPEC_HASH]: i.specHash,
      [LABEL_IMAGE_ID]: i.imageId,
      [LABEL_IMAGE]: i.image,
    },
  };
}

export interface EnsureResult {
  containerId: string;
  action: "created" | "recreated" | "started";
  imageId: string;
  claudeCodeVersion?: string;
}

/** One container per agent, found by name and labels (no DB column). Spec §11.1–11.3. */
export class ContainerManager {
  private readonly docker: DockerClient;
  private readonly log: RuntimeLog;
  private readonly uid: number | undefined;
  private readonly gid: number | undefined;

  /**
   * `uid`/`gid` override the host ids written into the container (tests run on hosts with different ids). They can't
   * bypass the root refusal: `ensure` refuses when either the server's own ids or the given ones are root.
   */
  constructor(d: { docker: DockerClient; log: RuntimeLog; uid?: number; gid?: number }) {
    this.docker = d.docker;
    this.log = d.log;
    this.uid = d.uid ?? process.getuid?.();
    this.gid = d.gid ?? process.getgid?.();
  }

  /** Pulls only when the image is missing locally, never to update a present tag (spec §11.2). */
  async ensureImage(ref: string, signal: AbortSignal): Promise<void> {
    if ((await this.docker.imageId(ref)) !== undefined) return;
    this.log.info({ image: ref }, "pulling image");
    await this.docker.pull(ref, signal);
  }

  /** Stops the agent's container when it runs (bounded). True when it was running. */
  async stopIfRunning(agentId: string, slug: string): Promise<boolean> {
    const c = await this.ours(agentId, slug);
    if (!c?.running) return false;
    await this.boundedStop(c.id);
    return true;
  }

  /**
   * Makes the agent's container exist with the current spec, running and ready. `mounts` are always re-checked here
   * with `checkMounts` (the only source of the container's mounts): once to compute the spec hash and again
   * immediately before the create and before the start, including when a stopped container is reused, because bind
   * sources resolve again at every container start.
   */
  async ensure(i: {
    agentId: string;
    slug: string;
    image: string;
    mounts: Mount[];
    mountCheck: MountCheckContext;
  }): Promise<EnsureResult> {
    const { uid, gid } = this;
    // The server's own ids too, so an injected non-root id never hides a factory running as root (spec §11.1).
    const root = [uid, gid, process.getuid?.(), process.getgid?.()].includes(0);
    if (uid === undefined || gid === undefined || root) throw new AgentStartError(ROOT_REFUSED);

    const imageId = await this.docker.imageId(i.image);
    if (imageId === undefined) throw new ImageMissingError(i.image);

    const checked = await checkMounts(i.mounts, i.mountCheck);
    const hash = specHash({ imageId, mounts: checked, uid, gid });
    /** Re-runs `checkMounts` right before a create or start and refuses a spec that changed meanwhile. */
    const recheck = async (): Promise<typeof checked> => {
      const again = await checkMounts(i.mounts, i.mountCheck);
      if (specHash({ imageId, mounts: again, uid, gid }) !== hash)
        throw new AgentStartError(
          "The agent's mounts changed while its container was being prepared. Try again.",
        );
      return again;
    };

    const name = containerName(i.slug, i.agentId);
    let existing = await this.ours(i.agentId, i.slug);
    let action: EnsureResult["action"] = "started";
    if (existing && existing.labels[LABEL_SPEC_HASH] !== hash) {
      this.log.info(
        { container: existing.id, slug: i.slug },
        "re-creating container (spec changed)",
      );
      await this.boundedStop(existing.id);
      await this.docker.remove(existing.id);
      existing = undefined;
      action = "recreated";
    }

    let id: string;
    let running: boolean;
    if (existing) {
      id = existing.id;
      running = existing.running;
    } else {
      const mounts = await recheck();
      id = await this.docker.create(
        createOptions({
          name,
          image: i.image,
          imageId,
          mounts,
          uid,
          gid,
          agentId: i.agentId,
          slug: i.slug,
          specHash: hash,
        }),
      );
      running = false;
      if (action !== "recreated") action = "created";
      this.log.info({ container: id, slug: i.slug, imageId }, `container ${action}`);
    }

    if (!running) {
      await recheck();
      await this.docker.start(id);
    }
    await this.waitReady(id, name);

    const claudeCodeVersion = await this.docker.imageLabel(imageId, LABEL_CLAUDE_CODE_VERSION);
    return {
      containerId: id,
      action,
      imageId,
      ...(claudeCodeVersion ? { claudeCodeVersion } : {}),
    };
  }

  /** Stops (never removes: unarchive must keep working) the agent's container. A missing or stopped one is fine. */
  async stop(agentId: string, slug: string): Promise<void> {
    await this.stopIfRunning(agentId, slug);
  }

  /**
   * The last resort when a stop failed twice (spec §9.6, Restart of a `stop_failed` agent): force-remove the agent's
   * container (Docker kills it first). Bounded like a stop. A missing container is fine.
   */
  async forceRemove(agentId: string, slug: string): Promise<boolean> {
    const c = await this.ours(agentId, slug);
    if (!c) return false;
    await bounded(
      this.docker.remove(c.id, { force: true }),
      STOP_BOUND_MS,
      `Removing container ${c.id} didn't finish within ${STOP_BOUND_MS / 1000} s.`,
    );
    this.log.warn({ container: c.id, slug }, "container removed after its stop failed");
    return true;
  }

  async isRunning(agentId: string, slug: string): Promise<boolean> {
    return (await this.ours(agentId, slug))?.running ?? false;
  }

  /**
   * The agent's container by name, only when its agent-id label says it is this agent's: the factory never starts,
   * stops or removes a container it didn't create.
   */
  private async ours(agentId: string, slug: string): Promise<ContainerInfo | undefined> {
    const name = containerName(slug, agentId);
    const c = await this.docker.findContainer(name);
    if (c && c.labels[LABEL_AGENT_ID] !== agentId)
      throw new AgentStartError(`A container named ${name} exists that the factory didn't create.`);
    return c;
  }

  /** Every container labelled with an agent id (spec §5.7 step 2), bounded so a hung daemon can't hold up boot. */
  async listOurs(): Promise<{ id: string; agentId: string; running: boolean }[]> {
    const listed = await bounded(
      this.docker.listByLabel(LABEL_AGENT_ID),
      LIST_BOUND_MS,
      `Listing containers didn't finish within ${LIST_BOUND_MS / 1000} s.`,
    );
    return listed.flatMap((c) => {
      const agentId = c.labels[LABEL_AGENT_ID];
      return agentId ? [{ id: c.id, agentId, running: c.running }] : [];
    });
  }

  /**
   * Stops a container `listOurs` returned (boot, spec §5.7 step 2), by id: its label already says it is ours, so it
   * needn't be found again by name. Bounded, never removed.
   */
  async stopListed(id: string): Promise<void> {
    await this.boundedStop(id);
  }

  /** `container.stop({t: 5})`, bounded so a Docker daemon that never answers can't hang the caller. */
  private async boundedStop(id: string): Promise<void> {
    await bounded(
      this.docker.stop(id, STOP_T_SECONDS),
      STOP_BOUND_MS,
      `Stopping container ${id} didn't finish within ${STOP_BOUND_MS / 1000} s.`,
    );
  }

  /** Polls for the ready marker as root (spec §11.1); fails with the last 50 log lines on timeout or exit. */
  private async waitReady(id: string, name: string): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      const left = () => Math.max(0, deadline - Date.now());
      try {
        // Each call is bounded by the time left, so one exec the daemon never answers can't outlast the deadline.
        const r = await bounded(
          this.docker.execRun(id, { cmd: ["test", "-f", READY_MARKER], user: "root" }),
          left(),
          "ready check timed out",
        );
        if (r.code === 0) return;
      } catch {
        // An exec fails once the container has exited (checked below) or when the deadline passes.
      }
      const state = await bounded(
        this.docker.findContainer(name),
        left(),
        "inspect timed out",
      ).then(
        (c) => (c?.running ? "running" : "exited"),
        () => "unknown", // no answer in time: the deadline check below decides
      );
      if (state === "exited")
        return this.failStart(id, "The agent's container exited before it was ready.");
      if (Date.now() >= deadline)
        return this.failStart(
          id,
          `The agent's container wasn't ready within ${READY_TIMEOUT_MS / 1000} s.`,
        );
      await sleep(READY_POLL_MS);
    }
  }

  private async failStart(id: string, why: string): Promise<never> {
    let logs: string;
    try {
      logs = (
        await bounded(this.docker.logsTail(id, LOG_TAIL_LINES), LOGS_BOUND_MS, "timed out")
      ).trimEnd();
    } catch (err) {
      logs = `(container logs unavailable: ${(err as Error).message})`;
    }
    try {
      await this.boundedStop(id); // don't leave a half-started container running
    } catch (err) {
      this.log.warn({ container: id, err }, "stopping a container that failed to start failed");
    }
    throw new AgentStartError(logs ? `${why}\n${logs}` : why);
  }
}
