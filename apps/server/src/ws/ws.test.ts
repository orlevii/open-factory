import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import { ev, FakeDriver } from "../agents/testing/fake-driver.ts";
import { sendAs } from "../agents/testing/runtime-harness.ts";
import { makeTestApp, signUp, TEST_ORIGIN } from "../test/helpers.ts";

let t: Awaited<ReturnType<typeof makeTestApp>>;
let url: string;
let session: Awaited<ReturnType<typeof signUp>>;
beforeAll(async () => {
  t = await makeTestApp();
  session = await signUp(t.app);
  await t.app.listen({ port: 0, host: "127.0.0.1" });
  url = `ws://127.0.0.1:${(t.app.server.address() as AddressInfo).port}/api/ws`;
});
afterAll(async () => {
  await t.close();
});

function open(headers: Record<string, string>, target = url) {
  return new Promise<{ ws: WebSocket; first: unknown }>((resolve, reject) => {
    const ws = new WebSocket(target, { headers });
    ws.once("message", (d) => resolve({ ws, first: JSON.parse(String(d)) }));
    ws.once("unexpected-response", (_req, res) => reject(new Error(`status ${res.statusCode}`)));
    ws.once("error", reject);
  });
}

test("cookie + matching origin: hello, then ping/pong, invalid message gets error", async () => {
  const { ws, first } = await open({ cookie: session.cookie, origin: TEST_ORIGIN });
  expect(first).toEqual({ type: "hello", userId: session.user.id });
  const next = () =>
    new Promise<unknown>((r) => ws.once("message", (d) => r(JSON.parse(String(d)))));
  ws.send(JSON.stringify({ type: "ping" }));
  expect(await next()).toEqual({ type: "pong" });
  ws.send("not json");
  expect(await next()).toMatchObject({ type: "error", code: "bad_message" });
  ws.close();
});

test("bearer without origin is accepted", async () => {
  const { ws, first } = await open({ authorization: `Bearer ${session.token}` });
  expect(first).toMatchObject({ type: "hello" });
  ws.close();
});

test.each([
  ["no session", { origin: TEST_ORIGIN }],
  ["bad origin", { cookie: "", origin: "http://evil.example" }],
  ["no origin without bearer", { cookie: "" }],
])("rejects %s with 401", async (_name, headers) => {
  const h = { ...headers } as Record<string, string>;
  if ("cookie" in h) h.cookie = session.cookie;
  await expect(open(h)).rejects.toThrow("status 401");
});

test("a frame over 64 KiB closes the socket with 1009", async () => {
  const { ws } = await open({ cookie: session.cookie, origin: TEST_ORIGIN });
  const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
  ws.send(JSON.stringify({ type: "ping", pad: "x".repeat(64 * 1024) }));
  expect(await closed).toBe(1009);
});

test("a frame of just under 64 KiB is still processed", async () => {
  const { ws } = await open({ cookie: session.cookie, origin: TEST_ORIGIN });
  const reply = new Promise<unknown>((r) => ws.once("message", (d) => r(JSON.parse(String(d)))));
  ws.send(JSON.stringify({ type: "ping", pad: "x".repeat(60 * 1024) }));
  expect(await reply).toEqual({ type: "pong" });
  ws.close();
});

describe("DEV_WEB_ORIGIN gating", () => {
  const DEV_ORIGIN = "http://localhost:5173";

  test("development: the dev web origin is accepted and trusted by better-auth", async () => {
    expect(t.config.isProduction).toBe(false);
    expect(t.app.auth.options.trustedOrigins).toContain(DEV_ORIGIN);
    const { ws, first } = await open({ cookie: session.cookie, origin: DEV_ORIGIN });
    expect(first).toMatchObject({ type: "hello" });
    ws.close();
  });

  describe("production", () => {
    let prod: Awaited<ReturnType<typeof makeTestApp>>;
    let prodUrl: string;
    let prodSession: Awaited<ReturnType<typeof signUp>>;
    beforeAll(async () => {
      prod = await makeTestApp({ env: { NODE_ENV: "production" } });
      prodSession = await signUp(prod.app);
      await prod.app.listen({ port: 0, host: "127.0.0.1" });
      prodUrl = `ws://127.0.0.1:${(prod.app.server.address() as AddressInfo).port}/api/ws`;
    });
    afterAll(async () => {
      await prod.close();
    });

    test("the dev web origin is rejected with 401 and not trusted by better-auth", async () => {
      expect(prod.config.isProduction).toBe(true);
      expect(prod.app.auth.options.trustedOrigins).toEqual([TEST_ORIGIN]);
      await expect(
        open({ cookie: prodSession.cookie, origin: DEV_ORIGIN }, prodUrl),
      ).rejects.toThrow("status 401");
    });

    test("PUBLIC_URL's origin is still accepted", async () => {
      const { ws, first } = await open(
        { cookie: prodSession.cookie, origin: TEST_ORIGIN },
        prodUrl,
      );
      expect(first).toMatchObject({ type: "hello" });
      ws.close();
    });
  });
});

describe("agent subscriptions", () => {
  let a: Awaited<ReturnType<typeof makeTestApp>>;
  let s: Awaited<ReturnType<typeof signUp>>;
  let wsUrl: string;
  let devId: string;
  const driver = new FakeDriver();
  beforeAll(async () => {
    a = await makeTestApp({ harnessDriver: driver });
    devId = (await a.seedAgent()).id;
    s = await signUp(a.app);
    await a.app.listen({ port: 0, host: "127.0.0.1" });
    wsUrl = `ws://127.0.0.1:${(a.app.server.address() as AddressInfo).port}/api/ws`;
  });
  afterAll(() => a.close());

  async function connect() {
    const ws = new WebSocket(wsUrl, { headers: { cookie: s.cookie, origin: TEST_ORIGIN } });
    const frames: Record<string, unknown>[] = [];
    ws.on("message", (d) => frames.push(JSON.parse(String(d))));
    await new Promise((r) => ws.once("open", r));
    const waitFor = async (pred: (f: Record<string, unknown>) => boolean, count = 1) => {
      for (let i = 0; i < 250; i++) {
        if (frames.filter(pred).length >= count) return frames.filter(pred);
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`timeout; got ${JSON.stringify(frames.map((f) => f.type))}`);
    };
    return { ws, frames, waitFor };
  }
  const seqs = (frames: Record<string, unknown>[]) =>
    frames.filter((f) => f.type === "session_event").map((f) => (f.event as { seq: number }).seq);

  test("subscribe replays from afterSeq, then streams live, with no gaps or duplicates", async () => {
    const rt = await a.app.runtimes.bySlug("dev");
    await sendAs(a.app.store, rt, {
      fromUserId: s.user.id,
      fromHandle: s.user.handle,
      body: "one",
      urgent: false,
    });
    driver.last.emit(ev.session(), ev.turn(), ev.text("a"), ev.usage(), ev.end());
    await rt?.settled(); // seq 1..7 exist
    const c = await connect();
    c.ws.send(JSON.stringify({ type: "subscribe", agent: "dev", afterSeq: 2 }));
    // live events written while the replay is being read
    await sendAs(a.app.store, rt, {
      fromUserId: s.user.id,
      fromHandle: s.user.handle,
      body: "two",
      urgent: false,
    });
    driver.last.emit(ev.turn(), ev.text("b"), ev.usage(), ev.end());
    await rt?.settled();
    await c.waitFor((f) => f.type === "session_event", 10);
    expect(seqs(c.frames)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(c.frames.some((f) => f.type === "queue")).toBe(true);
    c.ws.close();
  });

  test("events committed before and after the replay read are each sent exactly once, in order", async () => {
    const rt = await a.app.runtimes.bySlug("dev");
    if (!rt) throw new Error("no dev runtime");
    const start = await a.app.store.lastSeq(rt.agent.id);
    const store = a.app.store;
    const original = store.after.bind(store);
    // Deterministic race: while the subscriber is buffering, events land both before the DB read (so they are
    // in the replay rows and in the buffer) and after it (buffer only), plus a burst left running concurrently.
    const spy = vi.spyOn(store, "after").mockImplementationOnce(async (id, afterSeq, limit) => {
      driver.last.emit(ev.turn(), ev.text("before-read"));
      await rt.settled();
      const rows = await original(id, afterSeq, limit);
      driver.last.emit(ev.text("after-read"), ev.usage(), ev.end());
      await rt.settled();
      for (let i = 0; i < 20; i++) driver.last.emit(ev.text(`burst-${i}`));
      return rows;
    });
    try {
      const c = await connect();
      c.ws.send(JSON.stringify({ type: "subscribe", agent: "dev", afterSeq: start - 1 }));
      await c.waitFor((f) => f.type === "session_event", 1 + 2 + 3 + 20);
      await rt.settled();
      await new Promise((r) => setTimeout(r, 100));
      const expected = Array.from({ length: 26 }, (_, i) => start + i);
      expect(seqs(c.frames)).toEqual(expected);
      expect(spy).toHaveBeenCalledTimes(1);
      c.ws.close();
    } finally {
      spy.mockRestore();
    }
  });

  test("agent_status reaches sockets that didn't subscribe", async () => {
    const c = await connect();
    const rt = await a.app.runtimes.bySlug("dev");
    driver.last.emit(ev.turn());
    await rt?.settled();
    await c.waitFor((f) => f.type === "agent_status" && f.turnOpen === true);
    c.ws.close();
  });

  async function until(cond: () => boolean) {
    for (let i = 0; i < 250; i++) {
      if (cond()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("condition never held");
  }
  type AsyncFn = (...args: unknown[]) => Promise<unknown>;
  /** Holds the next call to `obj[key]` until the test calls `release()`; `started` resolves when it is entered. */
  function hold(obj: object, key: string) {
    const target = obj as Record<string, AsyncFn>;
    const original = (target[key] as AsyncFn).bind(obj);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const spy = vi.spyOn(target, key).mockImplementationOnce(async (...args: unknown[]) => {
      entered();
      await gate;
      return original(...args);
    });
    return { release, started, spy };
  }
  const devListeners = () => a.app.bus.listenerCount(devId);
  const settle = () => new Promise((r) => setTimeout(r, 100));

  test("unsubscribe stops live events and removes the listener", async () => {
    const rt = await a.app.runtimes.bySlug("dev");
    if (!rt) throw new Error("no dev runtime");
    const c = await connect();
    c.ws.send(
      JSON.stringify({
        type: "subscribe",
        agent: "dev",
        afterSeq: await a.app.store.lastSeq(rt.agent.id),
      }),
    );
    await c.waitFor((f) => f.type === "queue");
    await settle();
    expect(devListeners()).toBe(1);
    c.ws.send(JSON.stringify({ type: "unsubscribe", agent: "dev" }));
    await until(() => devListeners() === 0);
    driver.last.emit(ev.text("after-unsubscribe"));
    await rt.settled();
    await settle();
    expect(seqs(c.frames)).toEqual([]);
    c.ws.close();
  });

  test("closing while the agent lookup is pending leaves no bus listener", async () => {
    const allBefore = a.app.bus.listenerCount();
    const h = hold(a.app.runtimes, "bySlug");
    try {
      const c = await connect();
      c.ws.send(JSON.stringify({ type: "subscribe", agent: "dev", afterSeq: 0 }));
      await h.started;
      c.ws.close();
      await until(() => a.app.bus.listenerCount() === allBefore);
      h.release();
      await settle();
      expect(devListeners()).toBe(0);
    } finally {
      h.release();
      h.spy.mockRestore();
    }
  });

  test("an unsubscribe that arrives while the agent lookup is pending wins", async () => {
    const rt = await a.app.runtimes.bySlug("dev");
    if (!rt) throw new Error("no dev runtime");
    const h = hold(a.app.runtimes, "bySlug");
    try {
      const c = await connect();
      c.ws.send(
        JSON.stringify({
          type: "subscribe",
          agent: "dev",
          afterSeq: await a.app.store.lastSeq(rt.agent.id),
        }),
      );
      await h.started;
      c.ws.send(JSON.stringify({ type: "unsubscribe", agent: "dev" }));
      await settle();
      h.release();
      await settle();
      expect(devListeners()).toBe(0);
      driver.last.emit(ev.text("after-early-unsubscribe"));
      await rt.settled();
      await settle();
      expect(seqs(c.frames)).toEqual([]);
      expect(c.frames.some((f) => f.type === "queue")).toBe(false);
      c.ws.close();
    } finally {
      h.release();
      h.spy.mockRestore();
    }
  });

  test("closing during the replay leaves no bus listener", async () => {
    const h = hold(a.app.store, "after");
    try {
      const c = await connect();
      c.ws.send(JSON.stringify({ type: "subscribe", agent: "dev", afterSeq: 0 }));
      await h.started;
      expect(devListeners()).toBe(1);
      c.ws.close();
      await until(() => devListeners() === 0);
      h.release();
      await settle();
      expect(devListeners()).toBe(0);
    } finally {
      h.release();
      h.spy.mockRestore();
    }
  });

  test("a resubscribe cancels the in-flight replay of the earlier subscribe", async () => {
    const rt = await a.app.runtimes.bySlug("dev");
    if (!rt) throw new Error("no dev runtime");
    const last = await a.app.store.lastSeq(rt.agent.id);
    const h = hold(a.app.store, "after");
    try {
      const c = await connect();
      c.ws.send(JSON.stringify({ type: "subscribe", agent: "dev", afterSeq: 0 }));
      await h.started;
      c.ws.send(JSON.stringify({ type: "subscribe", agent: "dev", afterSeq: last }));
      await c.waitFor((f) => f.type === "queue", 2);
      await settle();
      h.release();
      await settle();
      driver.last.emit(ev.text("after-resubscribe"));
      await rt.settled();
      await c.waitFor((f) => f.type === "session_event");
      await settle();
      expect(seqs(c.frames)).toEqual([last + 1]);
      expect(devListeners()).toBe(1);
      c.ws.close();
      await until(() => devListeners() === 0);
    } finally {
      h.release();
      h.spy.mockRestore();
    }
  });

  test("the later of two subscribes wins even when its agent lookup finishes first", async () => {
    const rt = await a.app.runtimes.bySlug("dev");
    if (!rt) throw new Error("no dev runtime");
    const last = await a.app.store.lastSeq(rt.agent.id);
    const h = hold(a.app.runtimes, "bySlug"); // holds only the first subscribe's lookup
    try {
      const c = await connect();
      c.ws.send(JSON.stringify({ type: "subscribe", agent: "dev", afterSeq: 0 }));
      await h.started;
      c.ws.send(JSON.stringify({ type: "subscribe", agent: "dev", afterSeq: last }));
      await c.waitFor((f) => f.type === "queue");
      h.release();
      await settle();
      expect(seqs(c.frames)).toEqual([]);
      expect(c.frames.filter((f) => f.type === "queue")).toHaveLength(1);
      expect(devListeners()).toBe(1);
      c.ws.close();
      await until(() => devListeners() === 0);
    } finally {
      h.release();
      h.spy.mockRestore();
    }
  });

  test("a failure after registration unregisters and tells the client", async () => {
    const spy = vi.spyOn(a.app.store, "lastSeq").mockRejectedValueOnce(new Error("db down"));
    try {
      const c = await connect();
      c.ws.send(JSON.stringify({ type: "subscribe", agent: "dev", afterSeq: 0 }));
      await c.waitFor((f) => f.type === "error" && f.code === "internal_error");
      await settle();
      expect(devListeners()).toBe(0);
      c.ws.close();
    } finally {
      spy.mockRestore();
    }
  });

  test("a gap over 1000 events gets resync instead of a replay", async () => {
    const rt = await a.app.runtimes.bySlug("dev");
    const id = rt?.agent.id ?? "";
    for (let i = 0; i < 1001; i++)
      await a.app.store.append(id, null, { type: "background_tasks", tasks: [] });
    const c = await connect();
    c.ws.send(JSON.stringify({ type: "subscribe", agent: "dev", afterSeq: 0 }));
    await c.waitFor((f) => f.type === "resync");
    expect(seqs(c.frames)).toEqual([]);
    c.ws.close();
  });

  test("unknown agent", async () => {
    const c = await connect();
    c.ws.send(JSON.stringify({ type: "subscribe", agent: "nope", afterSeq: 0 }));
    await c.waitFor((f) => f.type === "error" && f.code === "agent_not_found");
    c.ws.close();
  });

  describe("live frames (U3 §11.3)", () => {
    let line = 1000;
    /** An open turn on the dev agent with "so far" streamed into a fresh block; returns its message id. */
    async function midAnswer() {
      const rt = await a.app.runtimes.bySlug("dev");
      if (!rt) throw new Error("no dev runtime");
      // a fresh turn, so earlier tests' blocks are gone
      if (rt.live().turnOpen) driver.last.emitAt(++line, ev.usage(), ev.end());
      driver.last.emitAt(++line, ev.turn());
      await rt.settled();
      const messageId = `msg_${line}`;
      driver.last.emitLive(
        { type: "text_start", messageId, index: 0, line: ++line },
        { type: "text_delta", messageId, index: 0, text: "so ", line: ++line },
        { type: "text_delta", messageId, index: 0, text: "far", line: ++line },
      );
      await settle();
      return { rt, messageId };
    }
    const delta = (messageId: string, text: string) =>
      driver.last.emitLive({ type: "text_delta", messageId, index: 0, text, line: ++line });
    const lives = (frames: Record<string, unknown>[]) => frames.filter((f) => f.type === "live");
    /** A few events back, so the replay is a replay (earlier tests wrote over 1000 events). */
    const recent = async () => {
      const rt = await a.app.runtimes.bySlug("dev");
      return Math.max(0, (await a.app.store.lastSeq(rt?.agent.id ?? "")) - 3);
    };

    test("subscribing mid-answer gets the replay, then one reset with the text so far", async () => {
      const { rt, messageId } = await midAnswer();
      const c = await connect();
      c.ws.send(JSON.stringify({ type: "subscribe", agent: "dev", afterSeq: await recent() }));
      await c.waitFor((f) => f.type === "live");
      const last = await a.app.store.lastSeq(rt.agent.id);
      const types = c.frames.map((f) => f.type);
      // after every replayed event
      expect(types.lastIndexOf("session_event")).toBeLessThan(types.indexOf("live"));
      expect(Math.max(...seqs(c.frames))).toBe(last);
      expect(lives(c.frames)).toEqual([
        expect.objectContaining({
          type: "live",
          agent: "dev",
          reset: true,
          texts: [{ messageId, index: 0, offset: 0, append: "so far" }],
        }),
      ]);
      // then patches from where the reset left off
      delta(messageId, "!");
      await c.waitFor((f) => f.type === "live", 2);
      expect(lives(c.frames)[1]).toEqual({
        type: "live",
        agent: "dev",
        texts: [{ messageId, index: 0, offset: 6, append: "!" }],
      });
      c.ws.close();
    });

    test("live frames published during the replay are dropped; the reset holds their text", async () => {
      const { messageId } = await midAnswer();
      const h = hold(a.app.store, "after");
      try {
        const afterSeq = await recent();
        const c = await connect();
        c.ws.send(JSON.stringify({ type: "subscribe", agent: "dev", afterSeq }));
        await h.started;
        delta(messageId, " and");
        await settle();
        delta(messageId, " more");
        await settle();
        h.release();
        await c.waitFor((f) => f.type === "live");
        await settle();
        expect(lives(c.frames)).toEqual([
          expect.objectContaining({
            reset: true,
            texts: [{ messageId, index: 0, offset: 0, append: "so far and more" }],
          }),
        ]);
        c.ws.close();
      } finally {
        h.spy.mockRestore();
      }
    });

    test("live_snapshot answers with a reset", async () => {
      const { rt, messageId } = await midAnswer();
      const c = await connect();
      c.ws.send(
        JSON.stringify({
          type: "subscribe",
          agent: "dev",
          afterSeq: await a.app.store.lastSeq(rt.agent.id),
        }),
      );
      await c.waitFor((f) => f.type === "live");
      c.ws.send(JSON.stringify({ type: "live_snapshot", agent: "dev" }));
      const [, second] = await c.waitFor((f) => f.type === "live", 2);
      expect(second).toMatchObject({
        type: "live",
        agent: "dev",
        reset: true,
        texts: [{ messageId, index: 0, offset: 0, append: "so far" }],
      });
      c.ws.close();
    });

    test("a windowed subscription (from the last seq, no replay) still receives live frames", async () => {
      const { rt, messageId } = await midAnswer();
      const c = await connect();
      c.ws.send(
        JSON.stringify({
          type: "subscribe",
          agent: "dev",
          afterSeq: await a.app.store.lastSeq(rt.agent.id),
        }),
      );
      await c.waitFor((f) => f.type === "live");
      delta(messageId, "?");
      await c.waitFor((f) => f.type === "live", 2);
      expect(seqs(c.frames)).toEqual([]);
      c.ws.close();
    });

    test("a socket not subscribed to the agent gets no live frames and no snapshot", async () => {
      const { messageId } = await midAnswer();
      const c = await connect();
      c.ws.send(JSON.stringify({ type: "live_snapshot", agent: "dev" }));
      delta(messageId, " unseen");
      await settle();
      // after an unsubscribe too
      const listeners = devListeners();
      c.ws.send(JSON.stringify({ type: "subscribe", agent: "dev", afterSeq: await recent() }));
      await c.waitFor((f) => f.type === "live");
      c.ws.send(JSON.stringify({ type: "unsubscribe", agent: "dev" }));
      await until(() => devListeners() === listeners);
      const before = lives(c.frames).length;
      c.ws.send(JSON.stringify({ type: "live_snapshot", agent: "dev" }));
      delta(messageId, " still unseen");
      await settle();
      expect(lives(c.frames)).toHaveLength(before);
      expect(before).toBe(1); // only the subscribe's own reset
      c.ws.close();
    });
  });
});
