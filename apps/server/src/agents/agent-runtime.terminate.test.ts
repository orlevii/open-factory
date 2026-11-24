import type { FastifyBaseLogger } from "fastify";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { Neighborhood } from "../messaging/neighborhood.ts";
import { Router } from "../messaging/router.ts";
import { ContainerManager, LABEL_AGENT_ID } from "../runtime/docker/containers.ts";
import { FakeDockerClient } from "../runtime/docker/testing/fake-docker.ts";
import { TerminateService } from "../spawning/terminate-service.ts";
import type { MountCheckContext } from "../workspace/mounts.ts";
import type { AgentRuntime, DockerDeps } from "./agent-runtime.ts";
import { AgentTerminatedError } from "./errors.ts";
import { EventBus } from "./event-bus.ts";
import { AgentRuntimes } from "./runtimes.ts";
import type { PrepareStart } from "./start.ts";
import { ev, FakeDriver } from "./testing/fake-driver.ts";
import { insertAgent } from "./testing/rows.ts";
import {
  noopTokens,
  okSpec,
  RuntimeHarness,
  sendAs,
  silentLog,
  testEffective,
} from "./testing/runtime-harness.ts";
import { RecordingSlots } from "./testing/slots.ts";

/** S7 §8: the runtime side of a termination (the latch, the stop job, the exit path), over the fake driver. */
const h = new RuntimeHarness();
beforeAll(() => h.setup());
afterAll(() => h.close());
/** Closers of the assembled worlds (`world()`), run after each test so a failing one never leaks its runtimes. */
const worlds: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const close of worlds.splice(0)) await close();
});

const events = async () => (await h.store.after(h.agentId, 0, 1000)).map((e) => e.event);
const stateOf = async (id: string) =>
  (await h.t.sql<{ state: string }[]>`select state from messages where id = ${id}`)[0]?.state;

/** A fake ContainerManager port that records what the runtime asked of it. */
function fakeContainers() {
  const ops: string[] = [];
  const f = {
    ops,
    removeError: undefined as Error | undefined,
    port: {
      ensure: async () => {
        ops.push("ensure");
        return { containerId: "c1", action: "created" as const, imageId: "sha256:img" };
      },
      stopIfRunning: async () => {
        ops.push("stop");
        return true;
      },
      forceRemove: async () => {
        ops.push("forceRemove");
        return true;
      },
      remove: async () => {
        ops.push("remove");
        if (f.removeError) throw f.removeError;
        return true;
      },
    } satisfies DockerDeps["containers"],
  };
  return f;
}

async function dockerRuntime(slots = new RecordingSlots()) {
  const c = fakeContainers();
  await h.makeRuntime({
    slots,
    docker: { containers: c.port, claudeBin: "/usr/local/bin/claude" },
    nextImage: "open-factory-base:dev",
    spec: (a) => ({
      ...okSpec(a),
      runtime: "docker",
      launch: { image: "open-factory-base:dev", mountCheck: {} as MountCheckContext },
    }),
  });
  return { c, slots };
}

/** A started, idle process on session sess-1. */
async function idle() {
  await h.send("hi");
  h.driver.last.emit(...ev.fullTurn("sess-1"));
  await h.rt.settled();
}

test("terminateStop: the terminated event, a forced stop, and the exit removes the container", async () => {
  const { c, slots } = await dockerRuntime();
  await idle();
  const proc = h.driver.last;
  h.rt.markTerminated({ committed: true });
  expect(h.rt.live().status).toBe("terminated");
  await h.rt.terminateStop("@or");
  await h.rt.settled();
  expect(proc.stopped).toBe(true);
  expect(c.ops).toEqual(["ensure", "remove"]); // removed, never only stopped
  expect(slots.events.at(-1)).toEqual(["release"]);
  const types = (await events()).map((e) => e.type);
  // Its exit lines follow the terminated line.
  expect(types.slice(types.indexOf("terminated"))).toEqual(["terminated", "cleanup", "exited"]);
  expect((await events()).find((e) => e.type === "terminated")).toEqual({
    type: "terminated",
    by: "@or",
  });
  expect(h.forwarded).toEqual([]);
  expect(h.driver.starts).toHaveLength(1); // no wake after a terminating exit
});

test("a failed container removal keeps the slot (stop_failed) and forwards nothing", async () => {
  const { c, slots } = await dockerRuntime();
  await idle();
  c.removeError = new Error("Removing container c1 didn't finish within 15 s.");
  h.rt.markTerminated({ committed: true });
  await h.rt.terminateStop("@or");
  await h.rt.settled();
  expect(slots.events).not.toContainEqual(["release"]);
  expect(slots.events.at(-1)).toEqual(["stop_failed"]);
  expect(h.rt.live().status).toBe("terminated");
  expect(h.forwarded).toEqual([]); // no errored fact
});

test("with no process, terminateStop removes the container and releases the slot at once", async () => {
  const { c, slots } = await dockerRuntime();
  // Never started in this server: the row's runtime decides.
  await h.t.sql`update agents set runtime = 'docker' where id = ${h.agentId}`;
  await h.rt.reload();
  h.rt.markTerminated({ committed: true });
  await h.rt.terminateStop("@lead");
  expect(c.ops).toEqual(["remove"]);
  expect(slots.events).toEqual([["release"]]);
  expect(await events()).toEqual([
    { type: "terminated", by: "@lead" },
    { type: "cleanup", container: "removed" },
  ]);
});

test("ensureTerminatedEvent appends the event once", async () => {
  await h.makeRuntime();
  h.rt.markTerminated({ committed: true });
  await h.rt.terminateStop("@or");
  await h.rt.terminateStop("@or");
  expect((await events()).filter((e) => e.type === "terminated")).toHaveLength(1);
});

test("a crash exit after the latch takes the terminate path: no recovery, no notice, nothing forwarded", async () => {
  await h.makeRuntime();
  await idle();
  const proc = h.driver.last;
  proc.emit(ev.turn()); // mid-turn: a plain crash here would be recovered
  await h.rt.settled();
  h.rt.markTerminated({ committed: true });
  proc.exit(137); // before the stop job runs: no stop intent is recorded
  await h.rt.settled();
  await h.rt.terminateStop("@or");
  await h.rt.settled();
  expect(h.driver.starts).toHaveLength(1);
  expect(await h.store.pendingQueue(h.agentId)).toEqual([]);
  const row = (
    await h.t.sql`select status, error_kind, attempting from agents where id = ${h.agentId}`
  )[0];
  expect(row).toEqual({ status: "hibernated", error_kind: null, attempting: false });
  expect(h.forwarded).toEqual([]);
  expect(h.rt.live().status).toBe("terminated");
});

test("rows rolled back from an in-flight batch are rejected, not pending again", async () => {
  await h.makeRuntime();
  const sent = await h.send("first"); // written before session_started: in flight
  const proc = h.driver.last;
  h.rt.markTerminated({ committed: true });
  await h.rt.terminateStop("@or");
  await h.rt.settled();
  expect(proc.stopped).toBe(true);
  expect(await stateOf(sent.id)).toBe("rejected");
  expect(h.rt.queueItems()).toEqual([]);
  expect(h.driver.starts).toHaveLength(1);
});

test("live background work is recorded as lost (reason terminated) and not forwarded", async () => {
  await h.makeRuntime();
  await idle();
  h.driver.last.emit(ev.background([{ taskId: "t1", description: "build" }]));
  await h.rt.settled();
  h.rt.markTerminated({ committed: true });
  await h.rt.terminateStop("@or");
  await h.rt.settled();
  expect(await events()).toContainEqual({
    type: "background_work_lost",
    reason: "terminated",
    tasks: [{ taskId: "t1", description: "build" }],
    crons: [],
  });
  expect(h.forwarded).toEqual([]);
});

test("nothing is forwarded once latched, not even the agent's own text", async () => {
  await h.makeRuntime();
  await idle();
  h.driver.last.emit(ev.turn());
  await h.rt.settled();
  h.rt.markTerminated({ committed: false });
  h.driver.last.emit(ev.text("a late report"), ev.end());
  await h.rt.settled();
  expect(h.forwarded).toEqual([]);
});

test("a provisional latch queues an arriving row without a wake; unmarking delivers it", async () => {
  const slots = new RecordingSlots();
  await h.makeRuntime({ slots });
  h.rt.markTerminated({ committed: false });
  expect(h.rt.live().status).not.toBe("terminated"); // a provisional latch doesn't show
  expect(h.rt.acceptsWake("message")).toBe(false);
  const item = await h.send("during the window");
  expect(slots.events).toEqual([]);
  expect(h.driver.starts).toHaveLength(0);
  expect(h.rt.queueItems()).toEqual([expect.objectContaining({ id: item.id })]);
  expect(await stateOf(item.id)).toBe("pending");
  h.rt.unmarkTerminated();
  await h.rt.settled();
  expect(h.rt.isTerminated()).toBe(false);
  expect(slots.events).toContainEqual(["request", "queued_items"]);
  expect(h.driver.last.sent.flat().map((m) => m.body)).toEqual(["during the window"]);
});

test("unmarking with a running process flushes what arrived during the window", async () => {
  await h.makeRuntime();
  await idle();
  h.rt.markTerminated({ committed: false });
  await h.send("queued meanwhile");
  expect(h.driver.last.sent).toHaveLength(1); // only the first batch
  h.rt.unmarkTerminated();
  await h.rt.settled();
  expect(h.driver.last.sent.flat().map((m) => m.body)).toEqual(["hi", "queued meanwhile"]);
});

test("a committed latch rejects an arriving row; a held row is rejected too", async () => {
  await h.makeRuntime();
  h.rt.markTerminated({ committed: true });
  const row = await h.row("too late");
  await expect(h.rt.deliver(row, { sender: "human", fromLabel: "@or" })).rejects.toBeInstanceOf(
    AgentTerminatedError,
  );
  expect(await stateOf(row.id)).toBe("rejected");
  expect(h.rt.queueItems()).toEqual([]);
  const held = await h.store.createHeld({
    kind: "member_update",
    toAgentId: h.agentId,
    subjectAgentId: h.agentId,
    notice: "errored",
    body: "x",
  });
  await h.receive(held);
  expect(await stateOf(held.id)).toBe("rejected");
  expect(h.driver.starts).toHaveLength(0);
});

test("a committed latch drops what was queued and cancels a pending apply-restart", async () => {
  await h.makeRuntime();
  h.rt.markTerminated({ committed: false });
  await h.send("queued");
  expect(h.rt.queueItems()).toHaveLength(1);
  h.rt.markTerminated({ committed: true });
  expect(h.rt.queueItems()).toEqual([]);
  expect(h.rt.hasDeliverable()).toBe(false);
  await h.rt.settled();
  // Dropped from memory and rejected in the DB (a row committed after the transaction's update still says so).
  const [queued] = await h.t.sql<
    { state: string }[]
  >`select state from messages where to_agent_id = ${h.agentId}`;
  expect(queued?.state).toBe("rejected");
  h.rt.unmarkTerminated(); // a committed latch is never undone
  expect(h.rt.isTerminated()).toBe(true);
});

test("reload never clears the latch", async () => {
  await h.makeRuntime();
  h.rt.markTerminated({ committed: false });
  await h.rt.reload();
  expect(h.rt.isTerminated()).toBe(true);
});

test("reload latches a row terminated elsewhere", async () => {
  await h.makeRuntime();
  await h.t
    .sql`update agents set kind = 'ephemeral', reports_to = ${h.agentId}, terminated_at = now(), terminated_by = '@factory' where id = ${h.agentId}`;
  await h.rt.reload();
  expect(h.rt.isTerminated()).toBe(true);
  expect(h.rt.live().status).toBe("terminated");
});

test("compact, interrupt, restart and reset-session are refused once terminated", async () => {
  await h.makeRuntime({ errorKind: "resume", status: "errored" });
  h.rt.markTerminated({ committed: true });
  await expect(h.rt.compact({ byHandle: "or" })).rejects.toBeInstanceOf(AgentTerminatedError);
  await expect(h.rt.interrupt({ byHandle: "or" })).rejects.toBeInstanceOf(AgentTerminatedError);
  await expect(h.rt.restart({ byHandle: "or", runtimeAllowed: true })).rejects.toBeInstanceOf(
    AgentTerminatedError,
  );
  await expect(h.rt.resetSession({ byHandle: "or" })).rejects.toBeInstanceOf(AgentTerminatedError);
  expect(h.driver.starts).toHaveLength(0);
});

test("a start inside prepareStart when the latch lands stops before the launch", async () => {
  let open!: () => void;
  await h.makeRuntime();
  h.prepareGate = new Promise<void>((r) => {
    open = r;
  });
  const sending = h.send("hi");
  await h.prepared(1);
  h.rt.markTerminated({ committed: false });
  open();
  await expect(sending).rejects.toThrow("The agent was terminated.");
  expect(h.driver.starts).toHaveLength(0);
});

test("provisional latches are counted: one failed termination doesn't undo another's", async () => {
  await h.makeRuntime();
  h.rt.markTerminated({ committed: false });
  h.rt.markTerminated({ committed: false });
  h.rt.unmarkTerminated();
  expect(h.rt.isTerminated()).toBe(true);
  expect(h.rt.acceptsWake("message")).toBe(false);
  h.rt.unmarkTerminated();
  expect(h.rt.isTerminated()).toBe(false);
});

test("unmarking restores an apply-restart the provisional latch held back", async () => {
  await h.makeRuntime();
  await idle();
  const proc = h.driver.last;
  proc.emit(ev.turn());
  await h.rt.settled();
  await h.rt.requestRestart();
  // A turn is open, so the restart waits; the latch cancels it for now.
  expect(h.rt.live().restartPending).toBe(true);
  h.rt.markTerminated({ committed: false });
  expect(h.rt.live().restartPending).toBe(false);
  proc.emit(ev.end());
  await h.rt.settled();
  expect(proc.stopped).toBe(false);
  h.rt.unmarkTerminated();
  await h.rt.settled();
  expect(proc.stopped).toBe(true); // idle: the restored restart applies at once
});

test("a Docker agent without the Docker runtime configured: the cleanup fails (stop_failed), the journal stays", async () => {
  const slots = new RecordingSlots();
  await h.makeRuntime({ slots });
  await h.t
    .sql`update agents set runtime = 'docker', runtime_journal = ${JSON.stringify({ tasks: [], crons: [] })}::jsonb where id = ${h.agentId}`;
  await h.rt.reload();
  h.rt.markTerminated({ committed: true });
  await h.rt.terminateStop("@or");
  expect(slots.events).toEqual([["stop_failed"]]);
  const [r] = await h.t.sql`select error_kind, runtime_journal from agents where id = ${h.agentId}`;
  expect(r).toEqual({ error_kind: "stop_failed", runtime_journal: { tasks: [], crons: [] } });
  expect(h.forwarded).toEqual([]);
});

// ---------- Terminate from every state (S7 §8, §12), over the assembled runtime side ----------

type Deferred = { promise: Promise<void>; resolve: () => void };
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const IMAGE = "open-factory-base:test";
const MOUNT_CHECK: MountCheckContext = {
  slug: "lead",
  workdir: "/nonexistent/of-test/workdir",
  grantedPaths: [],
  skillPaths: [],
  templateSkillPaths: [],
  templateDir: "/nonexistent/of-test/home/templates/t",
  declaredMarketplaceDirs: [],
  pluginsDir: "/nonexistent/of-test/plugins",
  cliBundle: "/nonexistent/of-test/cli.mjs",
  factoryHome: "/nonexistent/of-test/home",
  home: "/nonexistent/of-test/user",
  dockerSockets: [],
};

/** Fake Docker whose container stop or removal ends the fake Claude exec'd in it, as a real one does (V8). */
class Docker extends FakeDockerClient {
  constructor(private readonly driver: FakeDriver) {
    super();
  }
  override async stop(id: string, t: number) {
    await super.stop(id, t);
    this.endExecs(id);
  }
  override async remove(id: string, opts?: { force?: boolean }) {
    await super.remove(id, opts);
    this.endExecs(id);
  }
  private endExecs(id: string) {
    for (const p of this.driver.starts) if (p.spec.docker?.containerId === id) p.exit(137);
  }
  containersOf(agentId: string) {
    return [...this.containers.values()].filter((c) => c.labels[LABEL_AGENT_ID] === agentId);
  }
}

let worldSeq = 0;

/**
 * A spawner `lead` (local) and its spawned Docker child, on the real runtime side: `AgentRuntimes` (with its Supervisor,
 * cap 1, and image pulls), `ContainerManager` over fake Docker, the Router and `TerminateService`, over the fake
 * driver. `prepareGate` and `docker.pullGate` are deferreds the test opens; `startError` fails the next prepare.
 */
async function world(o: { memberUpdateDebounceMs?: number } = {}) {
  worldSeq += 1;
  const leadId = `lead-${worldSeq}`;
  const id = `kid-${worldSeq}`;
  await insertAgent(h.t.sql, { id: leadId, slug: `lead${worldSeq}` });
  await insertAgent(h.t.sql, { id, slug: `kid${worldSeq}`, reportsTo: leadId });
  await h.t.sql`update agents set kind = 'ephemeral', runtime = 'docker' where id = ${id}`;
  const driver = new FakeDriver();
  const docker = new Docker(driver);
  docker.images.set(IMAGE, { id: "sha256:img", labels: {} });
  const containers = new ContainerManager({
    docker,
    log: silentLog,
    uid: 501,
    gid: 20,
    checkImage: async () => {},
  });
  const prepareEntered = deferred();
  const gates = {
    prepare: undefined as Deferred | undefined,
    pull: undefined as Deferred | undefined,
    startError: undefined as Error | undefined,
  };
  const prepareStart: PrepareStart = async (a) => {
    if (a.id === id) prepareEntered.resolve();
    await gates.prepare?.promise;
    const err = gates.startError;
    gates.startError = undefined;
    if (err) throw err;
    return a.runtime === "docker"
      ? { ...okSpec(a), runtime: "docker", launch: { image: IMAGE, mountCheck: MOUNT_CHECK } }
      : okSpec(a);
  };
  const bus = new EventBus();
  let router: Router | undefined;
  const runtimes = new AgentRuntimes({
    store: h.store,
    bus,
    driver,
    prepareStart,
    tokens: noopTokens,
    log: silentLog,
    forward: (f) => (router ? router.forward(f) : Promise.resolve()),
    maxRunningAgents: () => 1,
    memberUpdateDebounceMs: () => o.memberUpdateDebounceMs ?? 3_600_000,
    docker: {
      containers,
      claudeBin: "/usr/local/bin/claude",
      defaultImage: IMAGE,
      resolver: { effective: async () => testEffective({ runtime: "docker" }) },
    },
  });
  router = new Router({
    db: h.t.db,
    store: h.store,
    runtimes,
    bus,
    log: silentLog as unknown as FastifyBaseLogger,
    neighborhood: new Neighborhood(h.t.db),
  });
  router.bootDone();
  const terminator = new TerminateService({
    db: h.t.db,
    store: h.store,
    runtimes,
    router,
    log: silentLog,
  });
  const load = async (agentId: string) => {
    const r = await runtimes.load(agentId);
    if (!r) throw new Error(`no runtime for ${agentId}`);
    return r;
  };
  const rt = await load(id);
  worlds.push(() => runtimes.close());
  const procsOf = (agentId: string) => driver.starts.filter((p) => p.spec.agentId === agentId);
  const holders = () => (runtimes.supervisor as unknown as { holders: Set<string> }).holders;
  const w = {
    id,
    leadId,
    rt,
    driver,
    docker,
    runtimes,
    terminator,
    gates,
    prepareEntered: prepareEntered.promise,
    load,
    sendHuman: (body: string, to: AgentRuntime = rt) =>
      sendAs(h.store, to, { fromUserId: "u1", body, urgent: false }),
    /** The child's latest process. */
    proc: () => {
      const p = procsOf(id).at(-1);
      if (!p) throw new Error("the child never started");
      return p;
    },
    procsOf,
    liveProcesses: (agentId = id) => procsOf(agentId).filter((p) => !p.exited),
    held: (agentId = id) => (holders().has(agentId) ? 1 : 0),
    terminate: (by = "@or") => terminator.terminate(id, by),
    /** Every gate opens: a start or pull they held resumes now, after the latch. */
    releaseGates: () => {
      gates.prepare?.resolve();
      gates.pull?.resolve();
    },
    settled: async () => {
      // A job may enqueue another runtime's (a hand-off to the spawner): settle both, twice.
      for (let i = 0; i < 2; i++) {
        await rt.settled();
        await (await load(leadId)).settled();
      }
    },
    row: async () =>
      (
        await h.t.sql<
          {
            attempting: boolean;
            runtime_journal: unknown;
            error_kind: string | null;
            terminated_at: string | null;
          }[]
        >`select attempting, runtime_journal, error_kind, terminated_at from agents where id = ${id}`
      )[0],
    pendingRowsTo: async () =>
      (
        await h.t.sql<
          { id: string }[]
        >`select id from messages where to_agent_id = ${id} and state = 'pending'`
      ).map((r) => r.id),
    /** Anything the child sent after its termination committed: member updates (forwards) included. */
    sentAfterTermination: async () =>
      (
        await h.t.sql<{ kind: string; body: string }[]>`select m.kind, m.body from messages m
          join agents a on a.id = m.from_agent_id
          where m.from_agent_id = ${id} and m.created_at >= a.terminated_at`
      ).map((r) => `${r.kind}: ${r.body}`),
    /** Every member update the child sent (its forwards to the spawner). */
    updatesFromChild: async () =>
      (
        await h.t.sql<
          { body: string }[]
        >`select body from messages where from_agent_id = ${id} and kind = 'member_update' order by created_at`
      ).map((r) => r.body),
    events: async () => (await h.store.after(id, 0, 1000)).map((e) => e.event),
    /** A started, idle child (its first turn ended). */
    idle: async () => {
      await w.sendHuman("hi");
      await w.settled(); // a Docker wake waits for the image check first: the grant job starts it
      w.proc().emit(...ev.fullTurn("sess-kid"));
      await w.settled();
    },
    /** The spawner runs and holds the only slot (its process started, no session yet: not evictable). */
    fillCap: async () => {
      await w.sendHuman("keep busy", await load(leadId));
      await w.settled();
      expect(w.held(leadId)).toBe(1);
    },
  };
  return w;
}

type World = Awaited<ReturnType<typeof world>>;

/** A started child whose stop timed out and whose escalation failed: `stop_failed`, keeping its slot. */
async function makeStopFailed(w: World) {
  await w.idle();
  const p = w.proc();
  p.stopResult = { code: null, signal: null, timedOut: true };
  p.emitExitOnStop = false;
  p.forceKill = async () => {
    throw new Error("Stopping the container didn't finish within 15 s.");
  };
  expect(await w.rt.hibernate("warm_window")).toBe(true);
  await w.settled();
  expect(w.rt.live().errorKind).toBe("stop_failed");
}

const states: {
  name: string;
  setup: (w: World) => Promise<void>;
  /** The removal fails too: the agent stays stuck (process, container, slot) for the sweep (Task 14) to retry. */
  stuck?: boolean;
}[] = [
  { name: "hibernated", setup: async () => {} },
  {
    name: "queued (cap full)",
    setup: async (w) => {
      await w.fillCap();
      await w.sendHuman("hi");
      expect(w.runtimes.supervisor.isQueued(w.id)).toBe(true);
    },
  },
  {
    name: "pulling",
    setup: async (w) => {
      w.docker.images.clear();
      w.gates.pull = deferred();
      w.docker.pullGate = w.gates.pull.promise;
      await w.sendHuman("hi");
      expect(w.runtimes.supervisor.isPulling(w.id)).toBe(true);
    },
  },
  {
    name: "in prepareStart",
    setup: async (w) => {
      w.gates.prepare = deferred();
      void w.sendHuman("hi").catch(() => {}); // refused by the latch: "The agent was terminated."
      await w.prepareEntered;
      expect(w.held()).toBe(1);
    },
  },
  {
    name: "working",
    setup: async (w) => {
      await w.sendHuman("hi");
      await w.settled();
      w.proc().emit(ev.session("sess-kid"), ev.turn());
      await w.settled();
    },
  },
  { name: "idle", setup: (w) => w.idle() },
  {
    name: "attempting (a crash recovery)",
    setup: async (w) => {
      await w.idle();
      w.proc().emit(ev.turn());
      await w.settled();
      w.proc().exit(137); // mid-turn: one automatic recovery attempt starts a new process
      await w.settled();
      expect((await w.row())?.attempting).toBe(true);
      expect(w.procsOf(w.id)).toHaveLength(2);
    },
  },
  {
    name: "rate-limited",
    setup: async (w) => {
      const credentialId = w.rt.agent.credentialId ?? "";
      w.runtimes.supervisor.pause(credentialId, new Date(Date.now() + 3_600_000), true);
      await w.sendHuman("hi");
      expect(w.runtimes.supervisor.isQueued(w.id)).toBe(true);
      // The reset comes after the termination: it must not start the agent.
      const release = w.releaseGates;
      w.releaseGates = () => {
        release();
        w.runtimes.supervisor.onCredentialReset(credentialId);
      };
    },
  },
  {
    name: "errored",
    setup: async (w) => {
      w.gates.startError = new Error("prepare blew up");
      await w.sendHuman("hi");
      await w.settled(); // the grant job's start fails
      expect(w.rt.live().status).toBe("errored");
    },
  },
  { name: "stop_failed", setup: makeStopFailed },
  {
    name: "stop_failed, and the container removal fails too",
    stuck: true,
    setup: async (w) => {
      await makeStopFailed(w);
      w.docker.removeError = new Error("the daemon refused");
    },
  },
  { name: "already terminated", setup: async (w) => void (await w.terminate("@lead")) },
];

test.each(states)("terminate from $name", async ({ setup, stuck = false }) => {
  const w = await world();
  await setup(w);
  const startsBefore = w.procsOf(w.id).length;
  expect(await w.terminate("@or")).toEqual({ status: "terminated" });
  w.releaseGates(); // prepare/pull gates resolve now: the latch must refuse the launch
  await w.settled();

  expect(w.procsOf(w.id)).toHaveLength(startsBefore); // nothing started after the latch
  expect(w.liveProcesses()).toHaveLength(stuck ? 1 : 0);
  expect(w.docker.containersOf(w.id)).toHaveLength(stuck ? 1 : 0);
  expect(await w.pendingRowsTo()).toEqual([]);
  expect(w.rt.queueItems()).toEqual([]);
  const row = await w.row();
  expect(row?.terminated_at).toBeTruthy();
  expect(row?.attempting).toBe(false);
  if (stuck) expect(row?.error_kind).toBe("stop_failed");
  else {
    // The sweep (Task 14) keys on both: a clean termination must leave neither, or the agent is swept forever.
    expect(row?.runtime_journal).toBeNull();
    expect(row?.error_kind).not.toBe("stop_failed");
  }
  expect(w.held()).toBe(stuck ? 1 : 0);
  expect(w.rt.live().status).toBe("terminated");
  expect((await w.events()).filter((e) => e.type === "terminated")).toHaveLength(1);
  expect(await w.sentAfterTermination()).toEqual([]);
});

// ---------- The races (S7 §8, §12) ----------
// Covered elsewhere, not repeated here: a send in the same tick as the termination (its row is `rejected`) and a forward
// from the child racing the commit (nothing written after it) in `spawning/terminate-service.test.ts`; a crash `exited`
// after the committed latch, and the provisional latch's own rules, above in this file. Terminate during `app.close()`
// is in `spawning/terminate-service.test.ts` (it needs the app).

/**
 * Holds the termination's transaction open right after its `terminateRows` (locks taken, rows written, not committed):
 * `entered` resolves then, and `release()` lets it commit (or `fail` makes it throw).
 */
function holdTermination(o: { fail?: Error } = {}) {
  const entered = deferred();
  const release = deferred();
  const original = h.store.terminateRows.bind(h.store);
  vi.spyOn(h.store, "terminateRows").mockImplementation(async (...a) => {
    const rejected = await original(...a);
    entered.resolve();
    await release.promise;
    if (o.fail) throw o.fail;
    return rejected;
  });
  return { entered: entered.promise, release: release.resolve };
}

/** Resolves once a backend of this test database waits on a lock (a real event, polled; never a sleep). */
async function lockWaiter() {
  for (;;) {
    const [r] = await h.t.sql<{ n: number }[]>`select count(*)::int as n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'`;
    if ((r?.n ?? 0) >= 1) return;
  }
}

test("a granted wake whose grant job is queued behind the termination starts nothing", async () => {
  const w = await world();
  await w.fillCap();
  await w.sendHuman("hi");
  expect(w.runtimes.supervisor.isQueued(w.id)).toBe(true);
  // Hold the child's job queue (a reload waiting on its row), so the grant job lands behind it.
  const gate = deferred();
  const original = h.store.agentById.bind(h.store);
  let held = false;
  vi.spyOn(h.store, "agentById").mockImplementation(async (agentId) => {
    if (agentId === w.id && !held) {
      held = true;
      await gate.promise;
    }
    return original(agentId);
  });
  const reloading = w.rt.reload();
  // The spawner goes: its slot is granted to the child, whose grant job queues behind the held reload.
  await (await w.load(w.leadId)).stop();
  expect(w.held()).toBe(1);
  await w.terminate();
  gate.resolve();
  await reloading;
  await w.settled();
  expect(w.procsOf(w.id)).toEqual([]);
  expect(w.held()).toBe(0);
  expect(w.docker.containersOf(w.id)).toEqual([]);
  expect(w.runtimes.supervisor.isQueued(w.id)).toBe(false);
});

test("a crash exit during the provisional window takes the terminate path: no crashed or errored fact, no recovery", async () => {
  const w = await world();
  await w.idle();
  const proc = w.proc();
  proc.emit(ev.turn()); // mid-turn: a plain crash here would be recovered
  await w.settled();
  const updatesBefore = await w.updatesFromChild();
  const hold = holdTermination();
  const terminating = w.terminate();
  await hold.entered;
  proc.exit(137);
  // The exit job runs inside the window: it removes the container, then its journal write waits on the child's row
  // lock the transaction holds (the transaction never waits on the job, so this resolves at the commit).
  await lockWaiter();
  expect(w.docker.containersOf(w.id)).toEqual([]);
  hold.release();
  await terminating;
  await w.settled();
  expect(w.procsOf(w.id)).toHaveLength(1); // no recovery wake
  expect(await w.updatesFromChild()).toEqual(updatesBefore);
  expect(await w.row()).toMatchObject({ attempting: false, error_kind: null });
  expect((await w.events()).filter((e) => e.type === "terminated")).toHaveLength(1);
});

test("an apply-restart pending when the latch lands never restarts the agent", async () => {
  const w = await world();
  await w.idle();
  const proc = w.proc();
  proc.emit(ev.turn());
  await w.settled();
  await w.rt.requestRestart(); // a turn is open: the restart waits for its end
  expect(w.rt.live().restartPending).toBe(true);
  const hold = holdTermination();
  const terminating = w.terminate();
  await hold.entered;
  proc.emit(ev.end()); // the turn ends inside the window: the cancelled restart must not stop it
  await w.settled();
  expect(proc.stopped).toBe(false);
  hold.release();
  await terminating;
  await w.settled();
  expect(proc.stopped).toBe(true); // stopped by the termination, not restarted
  expect(w.procsOf(w.id)).toHaveLength(1);
  expect(w.docker.containersOf(w.id)).toEqual([]);
});

test("a batch write in flight and the termination both complete: no deadlock", async () => {
  const w = await world();
  await w.idle();
  // Hold the batch's transaction after its message rows are updated (row locks held), before its commit.
  const entered = deferred();
  const gate = deferred();
  const original = h.store.markDelivered.bind(h.store);
  vi.spyOn(h.store, "markDelivered").mockImplementation(async (ids, tx) => {
    entered.resolve();
    await gate.promise;
    return original(ids, tx);
  });
  const row = await h.store.createMessage({
    from: { userId: "u1" },
    toAgentId: w.id,
    recipients: ["@test"],
    body: "mid-batch",
    urgent: false,
  });
  const sending = w.rt.deliver(row, { sender: "human", fromLabel: "@or" });
  await entered.promise;
  const terminating = w.terminate();
  // The termination took the agent rows (spawner, then child) and now waits on the batch's message row lock.
  await lockWaiter();
  gate.resolve();
  await sending;
  expect(await terminating).toEqual({ status: "terminated" });
  await w.settled();
  // The batch committed first: its row was delivered, so the termination's reject-pending skipped it.
  expect(await stateOf(row.id)).toBe("delivered");
  expect(w.liveProcesses()).toEqual([]);
  expect(w.docker.containersOf(w.id)).toEqual([]);
});

test("a provisional latch whose transaction fails: the held timer is re-armed and the update delivered", async () => {
  const w = await world({ memberUpdateDebounceMs: 60_000 });
  await w.idle();
  const proc = w.proc();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  // A member update to the child, held in its debounce window: the held timer is armed for its end.
  const update = await h.store.createHeld({
    kind: "member_update",
    toAgentId: w.id,
    fromAgentId: w.leadId,
    body: "an update",
  });
  await w.rt.receiveHeld(update);
  await w.settled();
  const hold = holdTermination({ fail: new Error("the database went away") });
  const terminating = w.terminate();
  await hold.entered;
  hold.release();
  await expect(terminating).rejects.toThrow("the database went away");
  expect(w.rt.isTerminated()).toBe(false);
  await w.settled();
  expect(proc.sent.flat().map((m) => m.body)).not.toContain("an update"); // still in its window
  vi.advanceTimersByTime(61_000);
  await w.settled();
  expect(proc.sent.flat().map((m) => m.body)).toContain("an update");
});

// ---------- The sweep (S7 §8 step 5, §10.2, §10.3) against a termination in progress ----------

test("a sweep during a termination that is still stopping: one terminated event, one slot release, one container removal", async () => {
  const w = await world();
  await w.idle();
  const proc = w.proc();
  proc.holdStop = true; // the termination's stop is under way and doesn't finish yet
  const release = vi.spyOn(w.runtimes.supervisor, "release");
  const removals = vi.spyOn(w.docker, "remove");
  await w.terminate();
  await w.settled();
  expect(proc.stopped).toBe(true);
  expect(proc.exited).toBe(false);
  // Never stuck while its stop is in progress: nothing done, the workspace must not go either.
  expect(await w.rt.sweepStuck()).toBe("still");
  expect(removals).not.toHaveBeenCalled();
  proc.releaseStop();
  await w.settled();
  // A sweep after the clean exit finds nothing left (the removal finds no container).
  expect(await w.rt.sweepStuck()).toBe("none");
  await w.settled();
  expect(removals).toHaveBeenCalledTimes(1);
  expect(release.mock.calls.filter(([a]) => a === w.id)).toHaveLength(1);
  expect((await w.events()).filter((e) => e.type === "terminated")).toHaveLength(1);
  expect(w.docker.containersOf(w.id)).toEqual([]);
  expect(await w.row()).toMatchObject({ runtime_journal: null, error_kind: null });
});

test("a stuck terminated agent records stop_escalated once, however many sweeps retry the escalation", async () => {
  const w = await world();
  await makeStopFailed(w);
  w.docker.removeError = new Error("the daemon refused");
  await w.terminate("@or");
  await w.settled();
  const escalations = async () => (await w.events()).filter((e) => e.type === "stop_escalated");
  const before = (await escalations()).length;
  expect(before).toBeGreaterThanOrEqual(1);
  expect(await w.rt.sweepStuck()).toBe("still");
  expect(await w.rt.sweepStuck()).toBe("still");
  await w.settled();
  expect((await escalations()).length).toBe(before); // the sweeps added none
});

test("a sweep while a shutdown stop is in progress does nothing", async () => {
  const w = await world();
  await w.idle();
  const proc = w.proc();
  proc.holdStop = true;
  const stopping = w.rt.stop(); // stopsInProgress > 0 until it returns
  await w.terminate();
  expect(await w.rt.sweepStuck()).toBe("still");
  proc.releaseStop();
  await stopping;
  await w.settled();
  expect((await w.events()).filter((e) => e.type === "terminated")).toHaveLength(1);
  expect(w.docker.containersOf(w.id)).toEqual([]);
});

test("last_activity_at is written after the batch commits, as its own statement (terminate vs a batch write)", async () => {
  const w = await world();
  await w.idle();
  const entered = deferred();
  const gate = deferred();
  const markDelivered = h.store.markDelivered.bind(h.store);
  vi.spyOn(h.store, "markDelivered").mockImplementation(async (ids, tx) => {
    entered.resolve();
    await gate.promise;
    return markDelivered(ids, tx);
  });
  let committed = false;
  const transaction = h.store.transaction.bind(h.store);
  vi.spyOn(h.store, "transaction").mockImplementation((async (
    fn: Parameters<typeof transaction>[0],
  ) => {
    const r = await transaction(fn);
    committed = true;
    return r;
  }) as typeof h.store.transaction);
  const atCall: boolean[] = [];
  const setLastActivity = h.store.setLastActivity.bind(h.store);
  const writes = vi.spyOn(h.store, "setLastActivity").mockImplementation(async (id, at) => {
    if (id === w.id) atCall.push(committed);
    return setLastActivity(id, at);
  });
  const old = new Date(Date.now() - 86_400_000);
  await h.t.sql`update agents set last_activity_at = ${old.toISOString()} where id = ${w.id}`;
  const row = await h.store.createMessage({
    from: { userId: "u1" },
    toAgentId: w.id,
    recipients: ["@test"],
    body: "mid-batch",
    urgent: false,
  });
  const sending = w.rt.deliver(row, { sender: "human", fromLabel: "@or" });
  await entered.promise;
  const terminating = w.terminate();
  await lockWaiter(); // the termination waits on the batch's message row lock
  expect(atCall).toEqual([]); // nothing written to the agent row while the batch's transaction is open
  gate.resolve();
  await sending;
  expect(await terminating).toEqual({ status: "terminated" });
  await w.settled();
  await Promise.all(writes.mock.results.map((r) => r.value));
  expect(atCall.length).toBeGreaterThanOrEqual(1);
  expect(atCall.every(Boolean)).toBe(true);
  const r = await h.store.agentById(w.id);
  expect(r?.lastActivityAt.getTime()).toBeGreaterThan(old.getTime());
});
