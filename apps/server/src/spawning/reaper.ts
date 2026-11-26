import type { RuntimeLog } from "../agents/agent-runtime.ts";
import type { EventStore } from "../agents/event-store.ts";
import type { AgentRuntimes } from "../agents/runtimes.ts";
import type { ContainerManager } from "../runtime/docker/containers.ts";
import type { Workspace } from "../workspace/workspace.ts";
import { EPHEMERAL_TTL_MS, SWEEP_INTERVAL_MS, WORKSPACE_GRACE_MS } from "./lifecycle.ts";
import type { TerminateService } from "./terminate-service.ts";

export interface ReaperDeps {
  store: Pick<
    EventStore,
    | "ttlCandidates"
    | "stuckCandidates"
    | "terminatedAmong"
    | "workspaceCandidates"
    | "agentById"
    | "refOfAgent"
    | "setWorkspaceDeleted"
  >;
  runtimes: Pick<AgentRuntimes, "load">;
  terminator: Pick<TerminateService, "terminate">;
  workspace: Pick<Workspace, "deleteWorkspace">;
  /**
   * Absent when the factory has no Docker runtime. Listed once per run, so a terminated agent's leftover container is
   * found however long ago it was terminated (S7 §8 step 5: a container still listed for it is stuck).
   */
  containers?: Pick<ContainerManager, "listOurs">;
  log: RuntimeLog;
  /** Wall-clock time (spec §10.3, decision R9: downtime counts). Tests inject it. */
  now: () => number;
  interval?: number;
}

/**
 * The spawned-agent sweep (S7 §10.3): every `SWEEP_INTERVAL_MS`, plus one run at the end of boot. In order: the TTL,
 * stuck terminations, workspace deletion. One run at a time; a failure is logged and retried by the next run.
 */
export class Reaper {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(private readonly d: ReaperDeps) {}

  start(): void {
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => void this.run(), this.d.interval ?? SWEEP_INTERVAL_MS);
  }

  /** The closing latch: no further run starts, and a run in progress stops at its next agent. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Resolves once a run in progress (if any) has finished. */
  async idle(): Promise<void> {
    await this.running;
  }

  /** One sweep. A run requested while one is in progress joins it. Never rejects. */
  run(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.running)
      this.running = this.sweep()
        .catch((err: unknown) => this.d.log.error({ err }, "the spawned-agent sweep failed"))
        .finally(() => {
          this.running = undefined;
        });
    return this.running;
  }

  private async sweep(): Promise<void> {
    const now = this.d.now();
    await this.ttl(now);
    const { still, dockerUnchecked } = await this.stuck(now);
    await this.workspaces(now, still, dockerUnchecked);
  }

  /** Step 1: idle spawned agents past the TTL, each re-checked and latched inside its own job. */
  private async ttl(now: number) {
    const cutoff = now - EPHEMERAL_TTL_MS;
    for (const a of await this.d.store.ttlCandidates(new Date(cutoff), new Date(now))) {
      if (this.stopped) return;
      try {
        const rt = await this.d.runtimes.load(a.id);
        if (!rt || !(await rt.reaperCheck(cutoff))) continue;
      } catch (err) {
        this.d.log.error({ err, agent: a.slug }, "checking an idle spawned agent failed");
        continue;
      }
      // Latched inside the check job; terminate runs from step 2, outside the agent's jobs. On failure the service
      // itself undoes this latch (provisional latches are counted): never undo it here too.
      await this.d.terminator
        .terminate(a.id, null, { latched: true })
        .catch((err: unknown) =>
          this.d.log.error(
            { err, agent: a.slug },
            "terminating an idle spawned agent failed; retrying next sweep",
          ),
        );
    }
  }

  /**
   * Step 2: stuck terminations. The candidates are bounded: the store's (`stop_failed`, a kept journal, a recent
   * termination) plus the terminated agents among this run's listed containers. Returns the ids still stuck or still
   * stopping, and whether Docker couldn't be listed (a leftover container may then mount a workspace).
   */
  private async stuck(now: number): Promise<{ still: Set<string>; dockerUnchecked: boolean }> {
    const still = new Set<string>();
    const listed = new Set<string>();
    let dockerUnchecked = false;
    if (this.d.containers)
      try {
        for (const c of await this.d.containers.listOurs()) listed.add(c.agentId);
      } catch (err) {
        dockerUnchecked = true;
        this.d.log.info({ err }, "Docker isn't reachable; leftover containers were not checked");
      }
    const candidates = await this.d.store.stuckCandidates(new Date(now - 2 * SWEEP_INTERVAL_MS));
    const known = new Set(candidates.map((a) => a.id));
    candidates.push(
      ...(await this.d.store.terminatedAmong([...listed].filter((id) => !known.has(id)))),
    );
    for (const a of candidates) {
      if (this.stopped) {
        still.add(a.id);
        continue;
      }
      try {
        const rt = await this.d.runtimes.load(a.id);
        if (!rt || (await rt.sweepStuck({ containerListed: listed.has(a.id) })) === "still")
          still.add(a.id);
      } catch (err) {
        still.add(a.id);
        this.d.log.error({ err, agent: a.slug }, "cleaning up a stuck termination failed");
      }
    }
    return { still, dockerUnchecked };
  }

  /**
   * Step 3: workspaces past the grace, unless pinned or the agent is still stuck (a container may mount it). A Docker
   * agent's waits for a run that could list the containers.
   */
  private async workspaces(now: number, stillStuck: Set<string>, dockerUnchecked: boolean) {
    for (const a of await this.d.store.workspaceCandidates(new Date(now - WORKSPACE_GRACE_MS))) {
      if (this.stopped) return;
      if (stillStuck.has(a.id) || a.errorKind === "stop_failed" || a.runtimeJournal) continue;
      if (dockerUnchecked && a.runtime === "docker") continue;
      try {
        await this.d.workspace.deleteWorkspace(
          await this.d.store.refOfAgent(a.id),
          async () => {
            const r = await this.d.store.agentById(a.id);
            return Boolean(r && !r.workspacePinned && !r.workspaceDeletedAt);
          },
          () => this.d.store.setWorkspaceDeleted(a.id, new Date(this.d.now())),
        );
      } catch (err) {
        this.d.log.error(
          { err, agent: a.slug },
          "deleting a workspace failed; retrying next sweep",
        );
      }
    }
  }
}
