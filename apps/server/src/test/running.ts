import type { AgentRow } from "@open-factory/db";
import type { FastifyInstance } from "fastify";
import { vi } from "vitest";
import type { Effective } from "../agents/config-resolver.ts";

const startedBy = new WeakMap<object, Map<string, Effective>>();

/**
 * I2 §6.2: spawning and the spawn tools follow what the spawner's running process started with (`startedOf`). For a
 * test that spawns through the service without driving a process, this makes each agent look running on its current
 * effective config (resolved now: call it again after changing the config). Other agents keep the real `startedOf`.
 * `vi.restoreAllMocks()` undoes it; a later call installs it again.
 */
export async function asRunning(app: FastifyInstance, ...agents: AgentRow[]): Promise<void> {
  const runtimes = app.runtimes;
  let started = startedBy.get(runtimes);
  if (!started || !vi.isMockFunction(runtimes.startedOf)) {
    const real = runtimes.startedOf.bind(runtimes);
    const map = new Map<string, Effective>();
    started = map;
    startedBy.set(runtimes, map);
    vi.spyOn(runtimes, "startedOf").mockImplementation((id) => map.get(id) ?? real(id));
  }
  for (const a of agents) {
    const row = await app.store.agentById(a.id);
    if (!row) throw new Error(`asRunning: no agent ${a.slug}`);
    started.set(a.id, await app.resolver.effective(row));
  }
}
