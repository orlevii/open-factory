import type { RuntimeLog } from "../agents/agent-runtime.ts";
import type { EventStore } from "../agents/event-store.ts";
import type { AgentRuntimes } from "../agents/runtimes.ts";
import type { Workspace } from "../workspace/workspace.ts";
import { EPHEMERAL_TTL_MS, SWEEP_INTERVAL_MS, WORKSPACE_GRACE_MS } from "./lifecycle.ts";
import type { TerminateService } from "./terminate-service.ts";

export interface ReaperDeps {
  store: Pick<
    EventStore,
    | "ttlCandidates"
    | "stuckCandidates"
    | "workspaceCandidates"
    | "agentById"
    | "setWorkspaceDeleted"
  >;
  runtimes: Pick<AgentRuntimes, "load">;
  terminator: Pick<TerminateService, "terminate">;
  workspace: Pick<Workspace, "deleteWorkspace">;
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
    const stillStuck = await this.stuck(now);
    await this.workspaces(now, stillStuck);
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
        .terminate(a.id, "@factory", { latched: true })
        .catch((err: unknown) =>
          this.d.log.error(
            { err, agent: a.slug },
            "terminating an idle spawned agent failed; retrying next sweep",
          ),
        );
    }
  }

  /** Step 2: stuck terminations (bounded candidates). Returns the ids still stuck or still stopping. */
  private async stuck(now: number): Promise<Set<string>> {
    const still = new Set<string>();
    for (const a of await this.d.store.stuckCandidates(new Date(now - 2 * SWEEP_INTERVAL_MS))) {
      if (this.stopped) {
        still.add(a.id);
        continue;
      }
      try {
        const rt = await this.d.runtimes.load(a.id);
        if (!rt || (await rt.sweepStuck()) === "still") still.add(a.id);
      } catch (err) {
        still.add(a.id);
        this.d.log.error({ err, agent: a.slug }, "cleaning up a stuck termination failed");
      }
    }
    return still;
  }

  /** Step 3: workspaces past the grace, unless pinned or the agent is still stuck (a container may mount it). */
  private async workspaces(now: number, stillStuck: Set<string>) {
    for (const a of await this.d.store.workspaceCandidates(new Date(now - WORKSPACE_GRACE_MS))) {
      if (this.stopped) return;
      if (stillStuck.has(a.id) || a.errorKind === "stop_failed" || a.runtimeJournal) continue;
      try {
        await this.d.workspace.deleteWorkspace(
          a.slug,
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
