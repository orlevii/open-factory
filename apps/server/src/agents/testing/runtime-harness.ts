import type { ServerMessage } from "@open-factory/shared";
import type { Forward } from "../../messaging/forwarder.ts";
import type { SlotPort } from "../../supervisor/slots.ts";
import { createTestDb } from "../../test/helpers.ts";
import { AgentRuntime, type RuntimeDeps } from "../agent-runtime.ts";
import { EventBus } from "../event-bus.ts";
import { EventStore, type PendingRow } from "../event-store.ts";
import type { PreparedSpec } from "../start.ts";
import { FakeDriver } from "./fake-driver.ts";
import { insertAgent } from "./rows.ts";
import { unlimitedSlots } from "./unlimited-slots.ts";

/** A human's committed message row for `rt`, as the Router writes it before the hand-off (S6 §7.3). */
export function humanRow(
  store: EventStore,
  rt: AgentRuntime,
  m: { fromUserId: string; body: string; urgent: boolean },
) {
  return store.createMessage({
    from: { userId: m.fromUserId },
    toAgentId: rt.agent.id,
    body: m.body,
    urgent: m.urgent,
  });
}

/** The hand-off of a human's row: the recipient's delivery job, enqueued synchronously. */
export const deliverHuman = (rt: AgentRuntime, row: PendingRow) =>
  rt.deliver(row, { sender: "human", fromLabel: `@${row.fromHandle}` });

/**
 * A human's message as the Router sends it: the committed row, then the delivery job (awaited by the caller, like
 * the REST route). `fromHandle` is ignored: the label comes from the joined row. Tests that need the job enqueued
 * at a precise moment use `humanRow` and `deliverHuman` instead.
 */
export async function sendAs(
  store: EventStore,
  rt: AgentRuntime | undefined,
  m: { fromUserId: string; fromHandle?: string; body: string; urgent: boolean },
) {
  if (!rt) throw new Error("no runtime");
  return deliverHuman(rt, await humanRow(store, rt, m));
}

export const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

/** A token port for tests that don't look at tokens. */
/** A forwarding port for tests that don't look at forwarding (S6 §9.1): nothing is persisted. */
export const noForward = async (): Promise<void> => {};

export const noopTokens = {
  mint: () => ({ token: "tok", generation: 1 }),
  revoke: () => {},
};

/** A local spec on the agent's own credential (`cred-<id>`, as `insertAgent` names it, when the row has none). */
export const okSpec = (a: {
  id: string;
  slug: string;
  credentialId?: string | null;
}): PreparedSpec => ({
  credentialId: a.credentialId ?? `cred-${a.id}`,
  agentId: a.id,
  slug: a.slug,
  cwd: "/w",
  env: { TOKEN_SEEN: "yes" },
  claudeBin: "claude",
  runtime: "local",
  permissionMode: "auto",
  mounts: [],
});

/**
 * One test DB and a fresh runtime per `makeRuntime()` call, over the fake driver. Call `setup()` in `beforeAll`
 * and `close()` in `afterAll`. `startError`, when set, is thrown by `prepareStart` at the next start.
 */
export class RuntimeHarness {
  t!: Awaited<ReturnType<typeof createTestDb>>;
  store!: EventStore;
  driver!: FakeDriver;
  bus!: EventBus;
  frames: ServerMessage[] = [];
  rt!: AgentRuntime;
  agentId = "";
  startError: Error | undefined;
  /** When set, `prepareStart` waits for it (a slow prepare). */
  prepareGate: Promise<void> | undefined;
  prepareCalls = 0;
  private prepareWaiters: { n: number; resolve: () => void }[] = [];
  /** Every token mint and revoke of the current runtime, in order. Reset by `makeRuntime`. */
  tokenCalls: ["mint" | "revoke", string, number][] = [];
  /** The `agentToken` the last `prepareStart` received. */
  lastAgentToken: string | undefined;
  /** Everything the runtimes forwarded (S6 §9.1), in order. Not reset by `makeRuntime`. */
  forwarded: Forward[] = [];
  /** When set, `forward` rejects with it (a failed insert). Reset by `makeRuntime`. */
  forwardError: Error | undefined;
  private minted = 0;
  private n = 0;

  /** Resolves once `prepareStart` has been entered `n` times (it may still be suspended in `prepareGate`). */
  prepared(n: number): Promise<void> {
    if (this.prepareCalls >= n) return Promise.resolve();
    return new Promise((resolve) => this.prepareWaiters.push({ n, resolve }));
  }

  async setup() {
    this.t = await createTestDb();
    this.store = new EventStore(this.t.db);
    await this.t
      .sql`insert into users (id, name, email, handle) values ('u1', 'Or', 'or@x.io', 'or')`;
  }

  close() {
    return this.t.close();
  }

  async makeRuntime(
    opts: {
      startError?: Error;
      errorKind?: string;
      sessionId?: string;
      status?: string;
      slots?: SlotPort;
      /** Pins the warm window in the agent's config snapshot; omitted (the factory default) by default. */
      warmWindowMinutes?: number;
      cleanup?: RuntimeDeps["cleanup"];
      journal?: RuntimeDeps["journal"];
      memberUpdateDebounceMs?: number;
      /** The Docker launcher; pair it with `spec` returning a Docker spec. */
      docker?: RuntimeDeps["docker"];
      /** What `prepareStart` returns (default: `okSpec`, a local spec). */
      spec?: (a: { id: string; slug: string }) => PreparedSpec;
      /** Runs after the agent row exists and before `init()` (rows a boot would find pending). */
      seed?: (agentId: string) => Promise<void>;
    } = {},
  ) {
    this.n += 1;
    this.agentId = `a${this.n}`;
    this.startError = opts.startError;
    this.forwardError = undefined;
    this.prepareGate = undefined;
    this.prepareCalls = 0;
    this.prepareWaiters = [];
    this.tokenCalls = [];
    this.lastAgentToken = undefined;
    this.minted = 0;
    await insertAgent(this.t.sql, {
      id: this.agentId,
      slug: `dev${this.n}`,
      ...(opts.errorKind ? { errorKind: opts.errorKind } : {}),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.warmWindowMinutes !== undefined
        ? { warmWindowMinutes: opts.warmWindowMinutes }
        : {}),
    });
    this.driver = new FakeDriver();
    this.bus = new EventBus();
    const frames: ServerMessage[] = [];
    this.frames = frames;
    this.bus.subscribeAll((m) => frames.push(m));
    const agent = await this.store.agentById(this.agentId);
    if (!agent) throw new Error("no agent");
    this.bus.subscribe(agent.slug, (m) => frames.push(m));
    this.rt = new AgentRuntime({
      agent,
      store: this.store,
      bus: this.bus,
      driver: this.driver,
      tokens: {
        mint: (id) => {
          this.minted += 1;
          this.tokenCalls.push(["mint", id, this.minted]);
          return { token: `tok-${this.minted}`, generation: this.minted };
        },
        revoke: (id, generation) => {
          this.tokenCalls.push(["revoke", id, generation]);
        },
      },
      prepareStart: async (a, extra) => {
        this.prepareCalls += 1;
        this.prepareWaiters = this.prepareWaiters.filter((w) => {
          if (this.prepareCalls < w.n) return true;
          w.resolve();
          return false;
        });
        this.lastAgentToken = extra.agentToken;
        if (this.prepareGate) await this.prepareGate;
        if (this.startError) throw this.startError;
        return opts.spec ? opts.spec(a) : okSpec(a);
      },
      log: silentLog,
      forward: async (f) => {
        if (this.forwardError) throw this.forwardError;
        this.forwarded.push(f);
      },
      holdTimeoutMs: 200,
      slots: opts.slots ?? unlimitedSlots,
      ...(opts.cleanup ? { cleanup: opts.cleanup } : {}),
      ...(opts.journal ? { journal: opts.journal } : {}),
      ...(opts.docker ? { docker: opts.docker } : {}),
      ...(opts.memberUpdateDebounceMs !== undefined
        ? { memberUpdateDebounceMs: opts.memberUpdateDebounceMs }
        : {}),
    });
    await opts.seed?.(this.agentId);
    await this.rt.init();
    return this.rt;
  }

  send = (body: string, urgent = false) =>
    sendAs(this.store, this.rt, { fromUserId: "u1", body, urgent });

  /** A committed human message row for the current runtime, not yet handed over. */
  row = (body: string, urgent = false) =>
    humanRow(this.store, this.rt, { fromUserId: "u1", body, urgent });

  /** Hands a held row (member update, peer event) to the runtime and waits for its jobs. */
  receive = async (row: PendingRow) => {
    await this.rt.receiveHeld(row);
    await this.rt.settled();
  };
}
