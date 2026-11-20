import { afterEach, expect, test, vi } from "vitest";
import { createShutdown } from "./shutdown.ts";

afterEach(() => {
  vi.useRealTimers();
});

test("runs every step in order and exits 0", async () => {
  const calls: string[] = [];
  const exit = vi.fn();
  const shutdown = createShutdown(
    [async () => void calls.push("app"), async () => void calls.push("db")],
    { exit, log: () => {} },
  );
  await shutdown();
  expect(calls).toEqual(["app", "db"]);
  expect(exit).toHaveBeenCalledExactlyOnceWith(0);
});

test("a failing step still runs the rest and exits 1", async () => {
  const calls: string[] = [];
  const exit = vi.fn();
  const log = vi.fn();
  const shutdown = createShutdown(
    [
      async () => {
        throw new Error("boom");
      },
      async () => void calls.push("db"),
    ],
    { exit, log },
  );
  await shutdown();
  expect(calls).toEqual(["db"]);
  expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("boom"));
});

test("a hung step is cut off by the force-exit timer", async () => {
  vi.useFakeTimers();
  const exit = vi.fn();
  const shutdown = createShutdown([() => new Promise(() => {})], {
    exit,
    log: () => {},
    timeoutMs: 10_000,
  });
  void shutdown();
  await vi.advanceTimersByTimeAsync(9_999);
  expect(exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(exit).toHaveBeenCalledExactlyOnceWith(1);
});

test("a second signal does not start a second shutdown", async () => {
  const step = vi.fn(async () => {});
  const exit = vi.fn();
  const shutdown = createShutdown([step], { exit, log: () => {} });
  await Promise.all([shutdown(), shutdown()]);
  expect(step).toHaveBeenCalledTimes(1);
  expect(exit).toHaveBeenCalledTimes(1);
});

test("the default force-exit budget is 20 s (agents get 3 s + 10 s to stop)", async () => {
  vi.useFakeTimers();
  const exit = vi.fn();
  const shutdown = createShutdown([() => new Promise(() => {})], { exit, log: () => {} });
  void shutdown();
  await vi.advanceTimersByTimeAsync(19_999);
  expect(exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(exit).toHaveBeenCalledWith(1);
});
