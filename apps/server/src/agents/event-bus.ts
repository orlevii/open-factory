import type { ServerMessage } from "@open-factory/shared";

type Listener = (m: ServerMessage) => void;

/** In-process fan-out. Publishers call it after commit, in seq order (spec §8.2). */
export class EventBus {
  private readonly byAgent = new Map<string, Set<Listener>>();
  private readonly all = new Set<Listener>();
  private readonly byUser = new Map<string, Set<Listener>>();
  private readonly closers = new Map<string, Set<() => void>>();

  subscribe(agentId: string, fn: Listener): () => void {
    const s = this.byAgent.get(agentId) ?? new Set<Listener>();
    this.byAgent.set(agentId, s);
    s.add(fn);
    return () => {
      s.delete(fn);
    };
  }
  publish(agentId: string, m: ServerMessage) {
    for (const fn of this.byAgent.get(agentId) ?? []) fn(m);
  }
  subscribeAll(fn: Listener): () => void {
    this.all.add(fn);
    return () => {
      this.all.delete(fn);
    };
  }
  /** One user's sockets (S8 §11.4): a read change reaches that user's other tabs, nobody else's. */
  subscribeUser(userId: string, fn: Listener): () => void {
    const s = this.byUser.get(userId) ?? new Set<Listener>();
    this.byUser.set(userId, s);
    s.add(fn);
    return () => {
      s.delete(fn);
      if (s.size === 0 && this.byUser.get(userId) === s) this.byUser.delete(userId);
    };
  }
  publishToUser(userId: string, m: ServerMessage) {
    for (const fn of this.byUser.get(userId) ?? []) fn(m);
  }
  /** Registers a closer for one of the user's sockets (S10 §9.4); the returned function unregisters it. */
  onUserClose(userId: string, fn: () => void): () => void {
    const s = this.closers.get(userId) ?? new Set<() => void>();
    this.closers.set(userId, s);
    s.add(fn);
    return () => {
      s.delete(fn);
      if (s.size === 0 && this.closers.get(userId) === s) this.closers.delete(userId);
    };
  }
  /** Closes every socket of a user; called after the disable transaction commits. */
  closeUser(userId: string) {
    for (const fn of [...(this.closers.get(userId) ?? [])]) fn();
  }
  /** Live listeners, per agent id or (without an id) on the broadcast channel. Used to check for leaks. */
  listenerCount(agentId?: string): number {
    return agentId === undefined ? this.all.size : (this.byAgent.get(agentId)?.size ?? 0);
  }
  publishAll(m: ServerMessage) {
    for (const fn of this.all) fn(m);
  }
}
