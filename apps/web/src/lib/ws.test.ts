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

test("backoff grows and is capped at 30s", async () => {
  const conn = connectWs({ ...base, onUnauthenticated: vi.fn(), hasSession: async () => true });
  // Fail many times without ever opening; each retry must come within the 30s cap.
  for (let i = 0; i < 10; i++) {
    FakeWs.instances.at(-1)?.onclose?.();
    await vi.advanceTimersByTimeAsync(30_001);
    expect(FakeWs.instances.length).toBe(i + 2);
  }
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
