import type { AgentRow } from "@open-factory/db";
import type { RuntimeLog } from "../agents/agent-runtime.ts";
import type { EventStore } from "../agents/event-store.ts";
import { notices } from "../agents/notices.ts";
import type { AgentRuntimes } from "../agents/runtimes.ts";
import { type Forward, factFor } from "../messaging/forwarder.ts";
import type { ContainerManager } from "../runtime/docker/containers.ts";
import type { ProcessJournal } from "../runtime/local/journal.ts";
import type { Supervisor } from "./supervisor.ts";

export interface ReconcileDeps {
  store: Pick<
    EventStore,
    | "listAgents"
    | "closeDanglingTurns"
    | "append"
    | "failCutShortAttempts"
    | "createNotice"
    | "clearRuntimeJournals"
    | "pausedCredentials"
    | "bootWakes"
    | "agentsWithYoungUpdates"
  >;
  journal: Pick<ProcessJournal, "reap">;
  /** Absent when the factory has no Docker runtime; step 2 is then skipped. */
  containers?: Pick<ContainerManager, "listOurs" | "stopListed">;
  supervisor: Pick<Supervisor, "pause">;
  runtimes: Pick<AgentRuntimes, "bySlug" | "load">;
  /** A member update younger than this is not yet deliverable (spec §8). */
  memberUpdateDebounceMs: number;
  /**
   * S6 §9.1: the Router's `forward`. Rows are persisted here; their hand-off to a manager waits for `bootDone()`, which
   * runs once this function has returned.
   */
  forward: (f: Forward) => Promise<void>;
  log: RuntimeLog;
}

/** The error of an agent whose attempt the server's stop cut short (spec §5.7 step 4), unless it already had one. */
export const ATTEMPT_CUT_SHORT = "The factory restarted during a recovery attempt.";

const hasProcess = (j: AgentRow["runtimeJournal"]) =>
  Boolean(j?.claude) || Boolean(j?.descendants?.length);

/**
 * Boot reconciliation (spec §5.7), in `buildApp` after the migrations and before the server listens, before any runtime
 * is constructed. Nothing from the previous run is left running, interrupted work gets its notice, and the wake queue
 * is rebuilt from the database. Never two processes for one session: every leftover is reaped or stopped before any
 * wake is requested.
 */
export async function reconcile(d: ReconcileDeps): Promise<void> {
  const rows = await d.store.listAgents();

  // 1. Local leftovers: the journaled Claude and its descendants, each signalled only while its start time matches.
  const killed = new Map<string, number>();
  // A reap that failed may have left a process running: its journal is kept (the next boot tries again) and the agent
  // isn't woken, so it never runs beside a leftover.
  const reapFailed = new Set<string>();
  await Promise.all(
    rows
      .filter((a) => hasProcess(a.runtimeJournal))
      .map(async (a) => {
        const j = a.runtimeJournal;
        if (!j) return;
        try {
          killed.set(a.id, await d.journal.reap(j));
        } catch (err) {
          reapFailed.add(a.id);
          d.log.error(
            { err, agent: a.slug },
            "reaping the previous run's processes failed; the agent isn't woken",
          );
        }
      }),
  );

  // 2. Docker leftovers: our agents' running containers are stopped (a Claude whose exec lost its client keeps
  // draining background work inside); containers of agents this database doesn't know are left alone.
  const stopped = rows.length ? await stopLeftoverContainers(d, rows) : new Set<string>();

  // 3. Dangling state: open turns closed, then per affected agent `reconciled` and the lost work its journal recorded.
  const dangling = new Set(await d.store.closeDanglingTurns());
  for (const a of rows) {
    const j = a.runtimeJournal;
    const lost = { tasks: j?.tasks ?? [], crons: j?.crons ?? [] };
    const anyLost = lost.tasks.length > 0 || lost.crons.length > 0;
    if (!hasProcess(j) && !stopped.has(a.id) && !dangling.has(a.id) && !anyLost) continue;
    await d.store.append(a.id, null, {
      type: "reconciled",
      killedProcesses: killed.get(a.id) ?? 0,
      stoppedContainer: stopped.has(a.id),
    });
    if (!anyLost) continue;
    await d.store.append(a.id, null, {
      type: "background_work_lost",
      reason: "factory_restarted",
      ...lost,
    });
    await forward(d, a, "work_lost", {
      lost: {
        tasks: lost.tasks.map((t) => t.description || t.taskId),
        crons: lost.crons.map((c) => c.humanSchedule),
      },
    });
  }

  // 4. Attempts cut short: errored, not woken (a crash-looping server must not spend tokens on every boot).
  const cutShort = new Set(await d.store.failCutShortAttempts(ATTEMPT_CUT_SHORT));
  for (const a of rows)
    if (cutShort.has(a.id)) {
      d.log.info(
        { agent: a.slug },
        "an attempt was cut short by the restart; the agent is errored",
      );
      // Errored with no attempt pending (S6 §9.1), once per episode: a human retry cut short was inside an episode
      // already reported (`errored_reported`, set by the Router); a crash's automatic attempt or a boot_resume was not.
      if (!a.erroredReported)
        await forward(d, a, "errored", { text: a.lastError ?? ATTEMPT_CUT_SHORT });
    }

  // 5. Interrupted work (R2): the factory-restarted notice, so the wake below resumes it (its single attempt).
  for (const a of rows) {
    if (a.archivedAt || a.status === "errored" || cutShort.has(a.id)) continue;
    const tasks = a.runtimeJournal?.tasks ?? [];
    if (!dangling.has(a.id) && !tasks.length) continue;
    await d.store.createNotice({
      toAgentId: a.id,
      notice: "factory_restarted",
      body: notices.factoryRestarted({ tasks: tasks.map((t) => t.description || t.taskId) }),
    });
  }

  // 7, ahead of 6: every journal was read and acted on. Cleared before any wake, so a process started below never
  // has its own fresh journal wiped.
  await d.store.clearRuntimeJournals([...reapFailed]);

  // 6. Reset timers first (a wake on a paused credential must wait, not start a process that can't write its first
  // line); a window that already passed resets at once, creating the owed continue notices.
  for (const p of await d.store.pausedCredentials()) d.supervisor.pause(p.id, p.until, p.exact);
  // Then the wakes, by each agent's oldest pending item, one at a time so the queue keeps that order. Each runtime is
  // loaded first: the Supervisor only wakes a loaded runtime.
  for (const w of await d.store.bootWakes(d.memberUpdateDebounceMs)) {
    if (reapFailed.has(w.id)) continue;
    try {
      const rt = await d.runtimes.bySlug(w.slug);
      await rt?.bootWake(w.resume ? "boot_resume" : "boot");
    } catch (err) {
      d.log.error({ err, agent: w.slug }, "boot wake failed");
    }
  }
  // S6 §8.2: an agent whose member updates are all still inside the window isn't woken, but its runtime is loaded so
  // `init()` arms the debounce timer that wakes it once the oldest is due (spec §17.2 "arms timers for young ones").
  for (const id of await d.store.agentsWithYoungUpdates(d.memberUpdateDebounceMs)) {
    if (reapFailed.has(id)) continue;
    try {
      await d.runtimes.load(id);
    } catch (err) {
      d.log.error({ err, agent: id }, "loading an agent with held updates failed");
    }
  }
}

/** A forwarding failure is logged: boot goes on, as for a failed wake (the fact is lost, the agent's state is not). */
async function forward(
  d: ReconcileDeps,
  a: AgentRow,
  fact: "work_lost" | "errored",
  detail: Parameters<typeof factFor>[2],
): Promise<void> {
  if (a.archivedAt) return;
  try {
    await d.forward({ agentId: a.id, fact, body: factFor(fact, a.slug, detail) });
  } catch (err) {
    // The fact is then not reported (for a cut-short attempt: its errored episode stays unreported); boot goes on.
    d.log.error({ err, agent: a.slug, fact }, "forwarding a fact to the manager failed");
  }
}

/**
 * Step 2. Unreachable Docker is a warn (an info when no agent uses Docker) and the step is skipped: every Docker start
 * stops a running container before it prepares anyway (spec §10), so a missed leftover never runs beside a new process.
 */
async function stopLeftoverContainers(d: ReconcileDeps, rows: AgentRow[]): Promise<Set<string>> {
  const stopped = new Set<string>();
  if (!d.containers) return stopped;
  const containers = d.containers;
  let listed: Awaited<ReturnType<ContainerManager["listOurs"]>>;
  try {
    listed = await containers.listOurs();
  } catch (err) {
    const msg = "Docker isn't reachable; leftover containers were not checked";
    if (rows.some((a) => a.runtime === "docker")) d.log.warn({ err }, msg);
    else d.log.info({ err }, msg);
    return stopped;
  }
  const ours = new Map(rows.map((a) => [a.id, a]));
  const foreign = listed.filter((c) => !ours.has(c.agentId)).map((c) => c.id);
  if (foreign.length)
    d.log.info(
      { containers: foreign },
      "containers of another factory or a deleted agent were left alone",
    );
  await Promise.all(
    listed
      .filter((c) => c.running && ours.has(c.agentId))
      .map(async (c) => {
        const slug = ours.get(c.agentId)?.slug;
        try {
          await containers.stopListed(c.id);
          stopped.add(c.agentId);
        } catch (err) {
          // The agent's next start stops it before anything else (spec §10 step 2).
          d.log.error(
            { err, agent: slug, container: c.id },
            "stopping a leftover container failed",
          );
        }
      }),
  );
  return stopped;
}
