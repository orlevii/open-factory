import type { AgentRuntime, RuntimeLog } from "../agents/agent-runtime.ts";
import type { EventBus } from "../agents/event-bus.ts";
import type { SlotPort, WakeReason } from "./slots.ts";

/** A wake waiting for a slot (spec §5.2). At most one per agent; `requestedAt` is its FIFO place. */
type Entry = { agentId: string; reason: WakeReason; requestedAt: number; pulling?: boolean };

export interface SupervisorDeps {
  max: number;
  /** The loaded runtimes. `all()` is for the closing latch and credential re-checks. */
  runtimes: { get(id: string): AgentRuntime | undefined; all(): Iterable<AgentRuntime> };
  bus: EventBus;
  log: RuntimeLog;
  credentialOf(agentId: string): string;
  paused(credentialId: string): boolean;
}

/**
 * The one owner of the cap (spec §5): slots, the FIFO wake queue, early hibernation and the closing latch.
 * Every method is synchronous bookkeeping; work on an agent is only ever enqueued as that agent's job, never
 * awaited, so a call from inside another agent's job can't deadlock (spec §5.5).
 */
export class Supervisor implements SlotPort {
  private readonly holders = new Set<string>();
  /** Slots handed over whose grant job hasn't run yet; the entry is kept to restore its place on a pause. */
  private readonly granted = new Map<string, Entry>();
  private queue: Entry[] = [];
  private readonly pendingEvictions = new Set<string>();
  private closed = false;
  private seq = 0;

  constructor(private readonly d: SupervisorDeps) {}

  requestWake(
    agentId: string,
    reason: WakeReason,
    inline: boolean,
  ): "granted" | "queued" | "dropped" {
    if (this.closed) return "dropped";
    const rt = this.d.runtimes.get(agentId);
    // Running, granted, starting or stop_failed: the slot is already held.
    if (!rt || this.holders.has(agentId) || !rt.acceptsWake(reason) || !rt.hasDeliverable())
      return "dropped";
    const at = this.queue.findIndex((e) => e.agentId === agentId);
    if (!this.pausedFor(agentId) && this.holders.size < this.d.max) {
      const entry = at === -1 ? this.entry(agentId, reason) : this.queue.splice(at, 1)[0];
      if (!entry) return "dropped";
      if (inline) {
        this.hold(agentId);
        rt.publishStatus();
        return "granted";
      }
      this.grantTo(rt, entry);
      // Not "granted": the caller isn't the grant job, which starts the agent in its own turn.
      return "queued";
    }
    if (at === -1) {
      this.queue.push(this.entry(agentId, reason));
      rt.publishStatus();
    }
    this.evict();
    return "queued";
  }

  release(agentId: string): void {
    if (!this.holders.has(agentId)) return;
    this.holders.delete(agentId);
    this.pendingEvictions.delete(agentId);
    const granted = this.granted.get(agentId);
    this.granted.delete(agentId);
    // A grant refused for a credential paused since it was granted goes back to its place (spec §5.2).
    if (granted && !this.closed && this.pausedFor(agentId)) this.requeue(granted);
    this.publish();
    this.pump();
  }

  /** Never throws: it runs in the `finally` of every runtime job. */
  becameHibernatable(_agentId: string): void {
    try {
      this.evict();
    } catch (err) {
      this.d.log.error({ err }, "eviction check failed");
    }
  }

  closing(): boolean {
    return this.closed;
  }

  /** The closing latch (spec §5.6): no grants, the queue dropped (its causes are durable), every runtime latched. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const dropped = this.queue.splice(0);
    this.pendingEvictions.clear();
    for (const rt of this.d.runtimes.all()) rt.setNoStart();
    for (const e of dropped) this.d.runtimes.get(e.agentId)?.publishStatus();
  }

  running(): { count: number; max: number } {
    return { count: this.holders.size, max: this.d.max };
  }

  isQueued(agentId: string): boolean {
    return this.queue.some((e) => e.agentId === agentId);
  }

  /** Whether the agent's credential is paused right now; read at every check, so a credential change applies. */
  pausedFor(agentId: string): boolean {
    return this.d.paused(this.d.credentialOf(agentId));
  }

  /** A credential's pause ended: its agents re-check their warm timers, and skipped entries become eligible. */
  onCredentialReset(credentialId: string): void {
    for (const rt of this.d.runtimes.all())
      if (this.d.credentialOf(rt.agent.id) === credentialId) rt.recheck();
    this.pump();
  }

  // ---------- internals ----------

  private entry(agentId: string, reason: WakeReason): Entry {
    this.seq += 1;
    return { agentId, reason, requestedAt: this.seq };
  }

  private requeue(e: Entry) {
    if (this.isQueued(e.agentId)) return;
    const at = this.queue.findIndex((q) => q.requestedAt > e.requestedAt);
    this.queue.splice(at === -1 ? this.queue.length : at, 0, e);
    this.d.runtimes.get(e.agentId)?.publishStatus();
  }

  private hold(agentId: string) {
    this.holders.add(agentId);
    this.publish();
  }

  /** Marks the agent granted (synchronously, closing the double-start window) and enqueues its grant job. */
  private grantTo(rt: AgentRuntime, e: Entry) {
    this.granted.set(e.agentId, e);
    this.hold(e.agentId);
    rt.publishStatus();
    void rt
      .grant(e.reason)
      .catch((err) => this.d.log.error({ err, agent: rt.agent.slug }, "grant job failed"))
      .finally(() => {
        if (this.granted.get(e.agentId) === e) this.granted.delete(e.agentId);
      });
  }

  /**
   * Whether the entry can take a slot now. "drop" for an entry that can never start from this request (archived,
   * an errored agent woken for a reason that doesn't wake it, nothing deliverable, already holding a slot).
   */
  private eligibility(e: Entry): "yes" | "paused" | "drop" {
    const rt = this.d.runtimes.get(e.agentId);
    if (!rt || this.holders.has(e.agentId) || !rt.acceptsWake(e.reason) || !rt.hasDeliverable())
      return "drop";
    return this.pausedFor(e.agentId) ? "paused" : "yes";
  }

  /** Grants free slots to the first eligible entries, in FIFO order; then evicts for what is still waiting. */
  private pump() {
    if (this.closed) return;
    while (this.holders.size < this.d.max) {
      const next = this.firstEligible();
      if (!next) break;
      const rt = this.d.runtimes.get(next.agentId);
      if (rt) this.grantTo(rt, next);
    }
    this.evict();
  }

  /** Removes and returns the first eligible entry; drops the ones that can never start; paused ones keep their place. */
  private firstEligible(): Entry | undefined {
    for (let i = 0; i < this.queue.length; ) {
      const e = this.queue[i] as Entry;
      const ok = this.eligibility(e);
      if (ok === "paused") i += 1;
      else {
        this.queue.splice(i, 1);
        if (ok === "yes") return e;
        this.d.runtimes.get(e.agentId)?.publishStatus();
      }
    }
    return undefined;
  }

  /**
   * Early hibernation (spec §5.3): while more entries are eligible than slots already on their way (evictions
   * asked for, holders stopping for another reason), ask the least recently active hibernatable holder to go.
   */
  private evict() {
    if (this.closed) return;
    const eligible = this.queue.filter((e) => this.eligibility(e) === "yes").length;
    let stopping = 0;
    for (const id of this.holders)
      if (!this.pendingEvictions.has(id) && this.d.runtimes.get(id)?.isStopping()) stopping += 1;
    while (eligible > this.pendingEvictions.size + stopping) {
      const victim = this.pickVictim();
      if (!victim) return;
      this.pendingEvictions.add(victim.agent.id);
      this.askToHibernate(victim);
    }
  }

  private pickVictim(): AgentRuntime | undefined {
    let best: AgentRuntime | undefined;
    for (const id of this.holders) {
      if (this.pendingEvictions.has(id) || this.granted.has(id)) continue;
      const rt = this.d.runtimes.get(id);
      if (!rt?.hibernatable()) continue;
      if (!best || rt.lastActivityAt < best.lastActivityAt) best = rt;
    }
    return best;
  }

  /** The victim re-checks in its own job; a refusal (a message arrived meanwhile) frees the pick for another. */
  private askToHibernate(rt: AgentRuntime) {
    const id = rt.agent.id;
    const refused = () => {
      if (!this.pendingEvictions.delete(id)) return;
      this.evict();
    };
    void rt.hibernate("freed_slot").then(
      (ok) => {
        if (!ok) refused();
      },
      (err) => {
        this.d.log.error({ err, agent: rt.agent.slug }, "freed_slot hibernate failed");
        refused();
      },
    );
  }

  private publish() {
    this.d.bus.publishAll({ type: "supervisor", running: this.holders.size, max: this.d.max });
  }
}
