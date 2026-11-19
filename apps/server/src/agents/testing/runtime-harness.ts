import type { AgentRuntimeSpec } from "@open-factory/harness";
import type { ServerMessage } from "@open-factory/shared";
import { createTestDb } from "../../test/helpers.ts";
import { AgentRuntime } from "../agent-runtime.ts";
import { EventBus } from "../event-bus.ts";
import { EventStore } from "../event-store.ts";
import { FakeDriver } from "./fake-driver.ts";
import { insertAgent } from "./rows.ts";

export const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

export const okSpec = (a: { id: string; slug: string }): AgentRuntimeSpec => ({
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
  private n = 0;

  async setup() {
    this.t = await createTestDb();
    this.store = new EventStore(this.t.db);
    await this.t
      .sql`insert into users (id, name, email, handle) values ('u1', 'Or', 'or@x.io', 'or')`;
  }

  close() {
    return this.t.close();
  }

  async makeRuntime(opts: { startError?: Error; sessionId?: string; status?: string } = {}) {
    this.n += 1;
    this.agentId = `a${this.n}`;
    this.startError = opts.startError;
    await insertAgent(this.t.sql, {
      id: this.agentId,
      slug: `dev${this.n}`,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.status ? { status: opts.status } : {}),
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
      prepareStart: async (a) => {
        if (this.startError) throw this.startError;
        return okSpec(a);
      },
      log: silentLog,
      holdTimeoutMs: 200,
    });
    await this.rt.init();
    return this.rt;
  }

  send = (body: string, urgent = false) =>
    this.rt.sendMessage({ fromUserId: "u1", fromHandle: "or", body, urgent });
}
