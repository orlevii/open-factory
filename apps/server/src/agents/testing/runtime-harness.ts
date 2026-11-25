import type { ServerMessage, TemplateConfig } from "@open-factory/shared";
import type { Forward } from "../../messaging/forwarder.ts";
import type { SlotPort } from "../../supervisor/slots.ts";
import { claimTestHandle } from "../../test/handles.ts";
import { createTestDb } from "../../test/helpers.ts";
import { AgentRuntime, type RuntimeDeps } from "../agent-runtime.ts";
import type { Effective } from "../config-resolver.ts";
import { EventBus } from "../event-bus.ts";
import { EventStore, type PendingRow } from "../event-store.ts";
import type { PreparedSpec } from "../start.ts";
import { FakeDriver } from "./fake-driver.ts";
import { insertAgent } from "./rows.ts";
import { RecordingSlots } from "./slots.ts";

/** A human's committed message row for `rt`, as the Router writes it before the hand-off (S6 §7.3). */
export function humanRow(
  store: EventStore,
  rt: AgentRuntime,
  m: { fromUserId: string; body: string; urgent: boolean },
) {
  return store.createMessage({
    from: { userId: m.fromUserId },
    toAgentId: rt.agent.id,
    recipients: [`@${rt.agent.slug}`],
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

/** An effective config for a fake start (I2 §6.2): a local agent with nothing in it; `config` overrides fields. */
export const testEffective = (config: Partial<TemplateConfig> = {}): Effective => ({
  doc: { template: {}, settings: {}, mcp: { mcpServers: {} } },
  config: {
    name: "test",
    displayName: "Test agent",
    description: "",
    runtime: "local",
    permissionMode: "auto",
    projects: [],
    skills: [],
    localSkills: true,
    secrets: [],
    canSpawn: [],
    ...config,
  },
  templateSkills: [],
  library: { skills: {} },
});

/**
 * A local spec on the agent's own credential (`cred-<id>`, as `insertAgent` names it, when the row has none);
 * `config` goes into the effective config it started with (`started`).
 */
export const okSpec = (
  a: {
    id: string;
    slug: string;
    credentialId?: string | null;
  },
  config: Partial<TemplateConfig> = {},
): PreparedSpec => ({
  credentialId: a.credentialId ?? `cred-${a.id}`,
  agentId: a.id,
  slug: a.slug,
  cwd: "/w",
  env: { TOKEN_SEEN: "yes" },
  claudeBin: "claude",
  runtime: "local",
  permissionMode: "auto",
  mounts: [],
  effective: testEffective(config),
});

/**
 * One test DB and a fresh runtime per `makeRuntime()` call, over the fake driver. Call `setup()` in `beforeAll`
 * and `close()` in `afterAll`. `startError`, when set, is thrown by `prepareStart` at the next start.
 */
const getter = (v: number | (() => number)) => (typeof v === "number" ? () => v : v);

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
    await claimTestHandle(this.t.db, "or", "user");
    await this.t
      .sql`insert into users (id, name, email, handle) values ('u1', 'Or', 'or@x.io', 'or')`;
  }

  async close() {
    if (this.rt) await this.rt.stop();
    await this.t.close();
  }

  async makeRuntime(
    opts: {
      startError?: Error;
      errorKind?: string;
      sessionId?: string;
      status?: string;
      slots?: SlotPort;
      /** Pins the warm window in the started config (the default spec's); omitted (the factory default) by default. */
      warmWindowMinutes?: number;
      cleanup?: RuntimeDeps["cleanup"];
      journal?: RuntimeDeps["journal"];
      /** The member-update debounce: a fixed value, or a getter a test changes (then calls `settingsChanged()`). */
      memberUpdateDebounceMs?: number | (() => number);
      /** The factory default warm window, read live (the runtime's 70 when absent). */
      defaultWarmWindowMinutes?: () => number;
      /** The Docker launcher; pair it with `spec` returning a Docker spec. */
      docker?: RuntimeDeps["docker"];
      /** What `prepareStart` returns (default: `okSpec`, a local spec). */
      spec?: (a: { id: string; slug: string }) => PreparedSpec;
      /** Runs after the agent row exists and before `init()` (rows a boot would find pending). */
      seed?: (agentId: string) => Promise<void>;
      /** The interrupt hold's fallback (200ms by default). */
      holdTimeoutMs?: number;
      /** I2 §6.2: the runtime's `nextImage` (what `AgentRuntimes` sets at load); pair it with a Docker spec. */
      nextImage?: string;
    } = {},
  ) {
    // The previous test's runtime stops first: a timer it left (an interrupt hold, a retry) must not write into the
    // next test, through the store they share.
    if (this.rt) await this.rt.stop();
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
        if (opts.spec) return opts.spec(a);
        return okSpec(
          a,
          opts.warmWindowMinutes !== undefined ? { warmWindowMinutes: opts.warmWindowMinutes } : {},
        );
      },
      log: silentLog,
      forward: async (f) => {
        if (this.forwardError) throw this.forwardError;
        this.forwarded.push(f);
      },
      holdTimeoutMs: opts.holdTimeoutMs ?? 200,
      slots: opts.slots ?? new RecordingSlots(),
      ...(opts.cleanup ? { cleanup: opts.cleanup } : {}),
      ...(opts.journal ? { journal: opts.journal } : {}),
      ...(opts.docker ? { docker: opts.docker } : {}),
      ...(opts.memberUpdateDebounceMs !== undefined
        ? { memberUpdateDebounceMs: getter(opts.memberUpdateDebounceMs) }
        : {}),
      ...(opts.defaultWarmWindowMinutes
        ? { defaultWarmWindowMinutes: opts.defaultWarmWindowMinutes }
        : {}),
    });
    this.rt.nextImage = opts.nextImage;
    await opts.seed?.(this.agentId);
    await this.rt.init();
    return this.rt;
  }

  send = (body: string, urgent = false) =>
    sendAs(this.store, this.rt, { fromUserId: "u1", body, urgent });

  /** A committed human message row for the current runtime, not yet handed over. */
  row = (body: string, urgent = false) =>
    humanRow(this.store, this.rt, { fromUserId: "u1", body, urgent });

  /** Hands a member update or peer event to the runtime, as the Router does, and waits for its jobs. */
  receive = async (row: PendingRow) => {
    await this.rt.receive(row);
    await this.rt.settled();
  };
}
