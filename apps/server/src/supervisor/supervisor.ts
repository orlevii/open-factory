import type { AgentRuntime, RuntimeLog } from "../agents/agent-runtime.ts";
import type { EventBus } from "../agents/event-bus.ts";
import type { EventStore } from "../agents/event-store.ts";
import type { CredentialPause, SlotPort, WakeReason } from "./slots.ts";

/**
 * A wake waiting for a slot (spec §5.2). At most one per agent; `requestedAt` is its FIFO place. `pulling` names the
 * image a Docker agent's wake waits for (spec §11.2): the entry keeps its place but isn't eligible until it resolves.
 */
type Entry = { agentId: string; reason: WakeReason; requestedAt: number; pulling?: string };

/** A paused credential (spec §7.2): one reset timer each. `until` is epoch ms. */
type Pause = { until: number; exact: boolean; timer?: ReturnType<typeof setTimeout> };

/** setTimeout's longest delay; a longer window re-arms when it fires early. */
const MAX_TIMER_MS = 2_147_483_647;

export interface SupervisorDeps {
  max: number;
  /** The loaded runtimes. `all()` is for the closing latch and credential re-checks. */
  runtimes: { get(id: string): AgentRuntime | undefined; all(): Iterable<AgentRuntime> };
  bus: EventBus;
  log: RuntimeLog;
  credentialOf(agentId: string): string;
  /** The reset's durable side (spec §7.2): owed agents, the credential's name, clearing the columns. */
  rateLimits: Pick<EventStore, "owedAgents" | "credentialName" | "clearCredentialPause">;
  /** Loads an agent's runtime (an owed agent may be hibernated and not loaded). */
  load(slug: string): Promise<AgentRuntime | undefined>;
  /**
   * Docker images (spec §11.2): `refOf` is the image a Docker agent starts from (undefined for a local agent);
   * `ensure` pulls it only when it is missing locally, and rejects with the registry's error.
   */
  images?: {
    refOf(agentId: string): string | undefined;
    ensure(ref: string, signal: AbortSignal): Promise<void>;
  };
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
  /** Paused credentials by id; an entry lasts until its reset has run, so nothing starts in between. */
  private readonly pauses = new Map<string, Pause>();
  private closed = false;
  private seq = 0;
  /** Image references found present (or pulled) by this server: their wakes skip the check. */
  private readonly presentImages = new Set<string>();
  /** One background check-and-pull per image reference; every waiting entry joins it. */
  private readonly pulls = new Map<string, Promise<void>>();
  /** The closing latch aborts in-flight pulls (spec §5.6). */
  private readonly closingSignal = new AbortController();

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
    // Spec §11.2: a Docker agent's image must be present before the grant. Until this server has seen it, the wake
    // waits in the queue as `pulling` (FIFO place kept) while one background check-and-pull runs per reference.
    const image = this.d.images?.refOf(agentId);
    if (image !== undefined && !this.presentImages.has(image)) {
      const queued = this.queue[at];
      if (!queued) this.queue.push({ ...this.entry(agentId, reason), pulling: image });
      else queued.pulling = image; // its place is kept; it waits for the check like a new entry
      rt.publishStatus();
      this.pull(image);
      return "queued";
    }
    if (at !== -1 && this.queue[at]?.pulling) return "queued";
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

  /**
   * A stop that failed even after escalation (spec §9.6): the holder keeps its slot (a process may still run), but
   * it is no longer a slot on its way back, so an eviction it was counted as is picked again.
   */
  stopFailed(agentId: string): void {
    if (this.pendingEvictions.delete(agentId)) this.evict();
  }

  closing(): boolean {
    return this.closed;
  }

  /** The closing latch (spec §5.6): no grants, the queue dropped (its causes are durable), every runtime latched. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closingSignal.abort(new Error("The factory is shutting down."));
    const dropped = this.queue.splice(0);
    this.pendingEvictions.clear();
    // Reset timers too (spec §5.6): the columns and owed flags are durable, boot re-arms them.
    for (const p of this.pauses.values()) clearTimeout(p.timer);
    for (const rt of this.d.runtimes.all()) rt.setNoStart();
    for (const e of dropped) this.d.runtimes.get(e.agentId)?.publishStatus();
  }

  running(): { count: number; max: number } {
    return { count: this.holders.size, max: this.d.max };
  }

  /**
   * Waiting for a start (the `queued` status input, spec §5.4): a queue entry, or a slot granted whose grant job
   * hasn't started the agent yet (so the status never flickers to hibernated in between). An entry that can never
   * start (archived, an errored agent's non-waking reason, nothing deliverable) is dropped here at once.
   */
  isQueued(agentId: string): boolean {
    if (this.granted.has(agentId)) return true;
    const at = this.queue.findIndex((e) => e.agentId === agentId);
    if (at === -1) return false;
    if (this.eligibility(this.queue[at] as Entry) !== "drop") return true;
    this.queue.splice(at, 1);
    return false;
  }

  isPulling(agentId: string): boolean {
    return Boolean(this.queue.find((e) => e.agentId === agentId)?.pulling);
  }

  /** `ensure` found the image gone (removed after it was seen): the next wake checks and pulls again. */
  forgetImage(ref: string): void {
    this.presentImages.delete(ref);
  }

  /** Whether the credential is rate-limit paused (spec §7.2). */
  paused(credentialId: string): boolean {
    return this.pauses.has(credentialId);
  }

  /** Whether the agent's credential is paused right now; read at every check, so a credential change applies. */
  pausedFor(agentId: string): boolean {
    return this.paused(this.d.credentialOf(agentId));
  }

  pauseOf(agentId: string): CredentialPause | undefined {
    const p = this.pauses.get(this.d.credentialOf(agentId));
    return p ? { until: new Date(p.until), exact: p.exact } : undefined;
  }

  /**
   * Pauses the credential (spec §7.2) with one reset timer. A later window replaces the timer; an earlier or equal
   * one changes nothing. Its agents re-check in a job: their status, and the warm timer (a paused idle agent may
   * hibernate with messages held).
   */
  pause(credentialId: string, until: Date, exact: boolean): void {
    if (this.closed) return;
    const cur = this.pauses.get(credentialId);
    if (cur && cur.until >= until.getTime()) return;
    if (cur) clearTimeout(cur.timer);
    const p: Pause = { until: until.getTime(), exact };
    this.pauses.set(credentialId, p);
    this.armReset(credentialId, p);
    for (const rt of this.onCredential(credentialId)) rt.recheck();
  }

  /** Grants what became eligible outside a slot change (an agent moved off a paused credential, spec §5.2). */
  recheckQueue(): void {
    this.pump();
  }

  /**
   * A credential's pause ended (its reset ran, spec §7.2): skipped entries become eligible in FIFO order, then each
   * of its agents flushes (running) or asks for a wake (pending items). Lifts only the in-memory pause: call it from
   * the reset path (after the columns are cleared) or a test, never instead of the reset.
   */
  onCredentialReset(credentialId: string): void {
    const p = this.pauses.get(credentialId);
    if (p) clearTimeout(p.timer);
    this.pauses.delete(credentialId);
    if (this.closed) return;
    this.pump();
    for (const rt of this.onCredential(credentialId)) rt.resumeAfterReset();
  }

  // ---------- internals ----------

  private *onCredential(credentialId: string): Iterable<AgentRuntime> {
    for (const rt of this.d.runtimes.all())
      if (this.d.credentialOf(rt.agent.id) === credentialId) yield rt;
  }

  private armReset(credentialId: string, p: Pause) {
    p.timer = setTimeout(
      () => {
        if (this.closed || this.pauses.get(credentialId) !== p) return;
        if (Date.now() < p.until) this.armReset(credentialId, p);
        else void this.reset(credentialId, p);
      },
      Math.min(MAX_TIMER_MS, Math.max(0, p.until - Date.now())),
    );
  }

  /**
   * The reset (spec §7.2, §7.3): owed agents get `rate_limit_reset` and the continue notice while the credential is
   * still paused (so the notice leads the first batch), then the columns are cleared and the pause lifted.
   */
  private async reset(credentialId: string, p: Pause) {
    try {
      const owed = await this.d.rateLimits.owedAgents(credentialId);
      if (owed.length) {
        const name = (await this.d.rateLimits.credentialName(credentialId)) ?? credentialId;
        for (const a of owed) {
          if (this.closed) return; // the owed flags stay: boot creates the notices
          // A later window replaced this one meanwhile: the flags stay, so its reset writes the true time.
          if (this.pauses.get(credentialId) !== p) return;
          try {
            const rt = this.d.runtimes.get(a.id) ?? (await this.d.load(a.slug));
            await rt?.rateLimitReset(
              { credential: name, ...(p.exact ? { at: new Date(p.until) } : {}) },
              () => !this.closed && this.pauses.get(credentialId) === p,
            );
          } catch (err) {
            // That agent keeps its owed flag (boot retries); the others still get theirs.
            this.d.log.error({ err, agent: a.slug }, "continue notice failed");
          }
        }
      }
      if (this.closed || this.pauses.get(credentialId) !== p) return;
      await this.d.rateLimits.clearCredentialPause(credentialId, new Date(p.until));
    } catch (err) {
      // Lift the pause anyway: a stuck pause would hold its agents forever. Boot retries what wasn't recorded.
      this.d.log.error({ err, credentialId }, "rate-limit reset failed");
    }
    if (this.closed || this.pauses.get(credentialId) !== p) return;
    this.onCredentialReset(credentialId);
  }

  /**
   * Starts (or joins) the check-and-pull of `ref` (spec §11.2). Success makes its entries eligible; a failure drops
   * them, and each agent records the failed start (errored `start`, the registry's error verbatim).
   */
  private pull(ref: string) {
    if (this.pulls.has(ref)) return;
    const images = this.d.images;
    if (!images) return;
    const done = (failure?: string) => {
      this.pulls.delete(ref);
      if (this.closed) return; // aborted by the closing latch: the entries are already dropped
      if (failure === undefined) this.presentImages.add(ref);
      for (const e of this.queue.filter((q) => q.pulling === ref)) {
        const rt = this.d.runtimes.get(e.agentId);
        if (failure === undefined) e.pulling = undefined;
        else {
          this.queue.splice(this.queue.indexOf(e), 1);
          void rt
            ?.imagePullFailed(failure)
            .catch((err) =>
              this.d.log.error({ err, agent: rt.agent.slug }, "recording a failed pull failed"),
            );
        }
        rt?.publishStatus();
      }
      this.pump();
    };
    this.d.log.info({ image: ref }, "checking the image before the start");
    const p = images.ensure(ref, this.closingSignal.signal).then(
      () => done(),
      (err: unknown) => {
        if (!this.closed) this.d.log.warn({ err, image: ref }, "image pull failed");
        done(err instanceof Error ? err.message : String(err));
      },
    );
    this.pulls.set(ref, p);
  }

  private entry(agentId: string, reason: WakeReason): Entry {
    this.seq += 1;
    return { agentId, reason, requestedAt: this.seq };
  }

  private requeue(e: Entry) {
    if (this.queue.some((q) => q.agentId === e.agentId)) return;
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
   * an errored agent woken for a reason that doesn't wake it, nothing deliverable, already holding a slot). An entry
   * of an agent whose attempt began since it was queued (Restart, Start a new session) is that attempt's wake and
   * keeps its place.
   */
  private eligibility(e: Entry): "yes" | "paused" | "pulling" | "drop" {
    const rt = this.d.runtimes.get(e.agentId);
    if (
      !rt ||
      this.holders.has(e.agentId) ||
      !rt.acceptsWake(rt.wakeReason(e.reason)) ||
      !rt.hasDeliverable()
    )
      return "drop";
    if (e.pulling) return "pulling";
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
      if (ok === "paused" || ok === "pulling") i += 1;
      else {
        this.queue.splice(i, 1);
        if (ok === "yes") return e;
        this.d.runtimes.get(e.agentId)?.publishStatus();
      }
    }
    return undefined;
  }

  /**
   * Early hibernation (spec §5.3): while more entries are eligible than slots free or already on their way
   * (evictions asked for, holders stopping for another reason), ask the least recently active hibernatable holder
   * to go. Free slots are counted too, so a caller that didn't pump first can't over-evict.
   */
  private evict() {
    if (this.closed) return;
    const eligible = this.queue.filter((e) => this.eligibility(e) === "yes").length;
    const free = Math.max(0, this.d.max - this.holders.size);
    let stopping = 0;
    for (const id of this.holders)
      if (!this.pendingEvictions.has(id) && this.d.runtimes.get(id)?.isStopping()) stopping += 1;
    while (eligible > free + this.pendingEvictions.size + stopping) {
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
