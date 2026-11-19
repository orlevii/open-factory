import type { Mount } from "@open-factory/harness";
import type { RuntimeLog } from "../../agents/agent-runtime.ts";
import { AgentStartError } from "../../agents/errors.ts";
import { checkMounts, type MountCheckContext } from "../../workspace/mounts.ts";
import type { ContainerCreateOptions, DockerClient } from "./client.ts";
import { EXTRA_HOSTS, SECURITY_OPT, specHash, TMPFS } from "./spec-hash.ts";

export { specHash };

export const LABEL_AGENT_ID = "io.open-factory.agent-id";
export const LABEL_SLUG = "io.open-factory.slug";
export const LABEL_SPEC_HASH = "io.open-factory.spec-hash";
export const LABEL_IMAGE_ID = "io.open-factory.image-id";
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const ROOT_REFUSED = "The factory runs as root; Docker agents need a non-root host user.";

export function containerName(slug: string, agentId: string): string {
  return `open-factory-${slug}-${agentId.slice(0, 8)}`;
}

/**
 * Spec §11.1: the S2 contract plus hardening. `Cmd` is the image default (`sleep infinity`), `Init` is unset (the
 * image's ENTRYPOINT runs tini), the network and pid namespaces are Docker's defaults, and the only mounts are the
 * ones passed in, which `ContainerManager.ensure` takes from `checkMounts` alone.
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
    Image: i.image,
    Env: [`HOST_UID=${i.uid}`, `HOST_GID=${i.gid}`],
    Labels: {
      [LABEL_AGENT_ID]: i.agentId,
      [LABEL_SLUG]: i.slug,
      [LABEL_SPEC_HASH]: i.specHash,
      [LABEL_IMAGE_ID]: i.imageId,
    },
    HostConfig: {
      Mounts: i.mounts.map((m) => ({
        Type: "bind" as const,
        Source: m.source,
        Target: m.target,
        ReadOnly: m.readOnly,
      })),
      Tmpfs: { ...TMPFS },
      ExtraHosts: [...EXTRA_HOSTS],
      SecurityOpt: [...SECURITY_OPT],
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
    const c = await this.docker.findContainer(containerName(slug, agentId));
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
    if (uid === undefined || gid === undefined || uid === 0 || gid === 0)
      throw new AgentStartError(ROOT_REFUSED);

    const imageId = await this.docker.imageId(i.image);
    if (imageId === undefined)
      throw new AgentStartError(`The image ${i.image} isn't available locally.`);

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
    let existing = await this.docker.findContainer(name);
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

    const claudeCodeVersion = await this.docker.imageLabel(i.image, LABEL_CLAUDE_CODE_VERSION);
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

  async isRunning(agentId: string, slug: string): Promise<boolean> {
    return (await this.docker.findContainer(containerName(slug, agentId)))?.running ?? false;
  }

  async listOurs(): Promise<{ id: string; agentId: string; running: boolean }[]> {
    return (await this.docker.listByLabel(LABEL_AGENT_ID)).flatMap((c) => {
      const agentId = c.labels[LABEL_AGENT_ID];
      return agentId ? [{ id: c.id, agentId, running: c.running }] : [];
    });
  }

  /** `container.stop({t: 5})`, bounded so a Docker daemon that never answers can't hang the caller. */
  private async boundedStop(id: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`Stopping container ${id} didn't finish within ${STOP_BOUND_MS / 1000} s.`),
          ),
        STOP_BOUND_MS,
      );
    });
    try {
      await Promise.race([this.docker.stop(id, STOP_T_SECONDS), bound]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Polls for the ready marker as root (spec §11.1); fails with the last 50 log lines on timeout or exit. */
  private async waitReady(id: string, name: string): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      try {
        const r = await this.docker.execRun(id, {
          cmd: ["test", "-f", READY_MARKER],
          user: "root",
        });
        if (r.code === 0) return;
      } catch {
        // An exec fails once the container has exited; checked below.
      }
      const c = await this.docker.findContainer(name);
      if (!c?.running)
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
      logs = (await this.docker.logsTail(id, LOG_TAIL_LINES)).trimEnd();
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
