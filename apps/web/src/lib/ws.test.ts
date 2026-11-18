import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { connectWs } from "./ws";

class FakeWs {
  static instances: FakeWs[] = [];
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (e: { data: string }) => void;
  constructor(public url: string) {
    FakeWs.instances.push(this);
  }
  send = vi.fn();
  close = vi.fn(() => this.onclose?.());
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWs.instances = [];
});
afterEach(() => {
  vi.useRealTimers();
});

const base = { WebSocketImpl: FakeWs as never, url: "ws://x/api/ws" };

test("on close with no session it calls onUnauthenticated and stops reconnecting", async () => {
  const onUnauthenticated = vi.fn();
  connectWs({ ...base, onUnauthenticated, hasSession: async () => false });
  FakeWs.instances[0]?.onclose?.();
  await vi.runAllTimersAsync();
  expect(onUnauthenticated).toHaveBeenCalledOnce();
  expect(FakeWs.instances).toHaveLength(1);
});

test("on close with a session it reconnects with backoff", async () => {
  const conn = connectWs({ ...base, onUnauthenticated: vi.fn(), hasSession: async () => true });
  FakeWs.instances[0]?.onclose?.();
  await vi.advanceTimersByTimeAsync(31_000);
  expect(FakeWs.instances.length).toBe(2);
  conn.close();
});

test("backoff grows exponentially with 0.5-1x jitter and is capped at 30s", async () => {
  const conn = connectWs({ ...base, onUnauthenticated: vi.fn(), hasSession: async () => true });
  // Fail repeatedly without ever opening. Attempt n waits between 0.5x and 1x of min(30s, 500ms * 2^n).
  for (let n = 0; n < 10; n++) {
    const ceiling = Math.min(30_000, 500 * 2 ** n);
    const before = FakeWs.instances.length;
    FakeWs.instances.at(-1)?.onclose?.();
    await vi.advanceTimersByTimeAsync(ceiling / 2 - 1);
    expect(FakeWs.instances.length, `attempt ${n} reconnected too early`).toBe(before);
    await vi.advanceTimersByTimeAsync(ceiling / 2 + 1);
    expect(FakeWs.instances.length, `attempt ${n} did not reconnect in time`).toBe(before + 1);
  }
  conn.close();
});

test("a failed session check (server error) keeps retrying and never signs out", async () => {
  const onUnauthenticated = vi.fn();
  const conn = connectWs({
    ...base,
    onUnauthenticated,
    hasSession: async () => {
      throw new Error("500");
    },
  });
  FakeWs.instances[0]?.onclose?.();
  await vi.advanceTimersByTimeAsync(31_000);
  expect(onUnauthenticated).not.toHaveBeenCalled();
  expect(FakeWs.instances.length).toBe(2);
  conn.close();
});

test("status tracks the socket and close() stops reconnecting", async () => {
  const hasSession = vi.fn(async () => true);
  const conn = connectWs({ ...base, onUnauthenticated: vi.fn(), hasSession });
  expect(conn.status()).toBe("connecting");
  FakeWs.instances[0]?.onopen?.();
  expect(conn.status()).toBe("open");
  conn.close();
  expect(conn.status()).toBe("closed");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(FakeWs.instances).toHaveLength(1);
  expect(hasSession).not.toHaveBeenCalled();
});

test("valid server messages are parsed and delivered; invalid ones are ignored", () => {
  const onMessage = vi.fn();
  connectWs({ ...base, onUnauthenticated: vi.fn(), hasSession: async () => true, onMessage });
  const ws = FakeWs.instances[0];
  ws?.onmessage?.({ data: JSON.stringify({ type: "hello", userId: "u1" }) });
  ws?.onmessage?.({ data: "not json" });
  ws?.onmessage?.({ data: JSON.stringify({ type: "nope" }) });
  expect(onMessage).toHaveBeenCalledTimes(1);
  expect(onMessage).toHaveBeenCalledWith({ type: "hello", userId: "u1" });
});

test("onStatus reports every transition once, in order", async () => {
  const onStatus = vi.fn();
  const conn = connectWs({
    ...base,
    onUnauthenticated: vi.fn(),
    hasSession: async () => true,
    onStatus,
  });
  FakeWs.instances[0]?.onopen?.();
  FakeWs.instances[0]?.onclose?.();
  await vi.advanceTimersByTimeAsync(1_000);
  FakeWs.instances[1]?.onopen?.();
  conn.close();
  expect(onStatus.mock.calls.map(([s]) => s)).toEqual([
    "connecting",
    "open",
    "closed",
    "connecting",
    "open",
    "closed",
  ]);
});

test("send() writes JSON only while open; onOpen fires on every open", async () => {
  const onOpen = vi.fn();
  const conn = connectWs({
    ...base,
    onUnauthenticated: vi.fn(),
    hasSession: async () => true,
    onOpen,
  });
  expect(conn.send({ type: "ping" })).toBe(false); // still connecting
  FakeWs.instances[0]?.onopen?.();
  expect(onOpen).toHaveBeenCalledOnce();
  expect(conn.send({ type: "ping" })).toBe(true);
  expect(FakeWs.instances[0]?.send).toHaveBeenCalledWith('{"type":"ping"}');
  FakeWs.instances[0]?.onclose?.();
  expect(conn.send({ type: "ping" })).toBe(false);
  conn.close();
});
