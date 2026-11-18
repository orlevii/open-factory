import type { ServerMessage } from "@open-factory/shared";

type Listener = (m: ServerMessage) => void;

/** In-process fan-out. Publishers call it after commit, in seq order (spec §8.2). */
export class EventBus {
  private readonly byAgent = new Map<string, Set<Listener>>();
  private readonly all = new Set<Listener>();

  subscribe(agentSlug: string, fn: Listener): () => void {
    const s = this.byAgent.get(agentSlug) ?? new Set<Listener>();
    this.byAgent.set(agentSlug, s);
    s.add(fn);
    return () => {
      s.delete(fn);
    };
  }
  publish(agentSlug: string, m: ServerMessage) {
    for (const fn of this.byAgent.get(agentSlug) ?? []) fn(m);
  }
  subscribeAll(fn: Listener): () => void {
    this.all.add(fn);
    return () => {
      this.all.delete(fn);
    };
  }
  /** Live listeners, per agent or (without a slug) on the broadcast channel. Used to check for leaks. */
  listenerCount(agentSlug?: string): number {
    return agentSlug === undefined ? this.all.size : (this.byAgent.get(agentSlug)?.size ?? 0);
  }
  publishAll(m: ServerMessage) {
    for (const fn of this.all) fn(m);
  }
}
