import { expect, test, vi } from "vitest";
import { UploadSweep } from "./sweep.ts";

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

test("a run requested during a run joins it; a failure is logged, never thrown; stop latches", async () => {
  let release!: () => void;
  const sweepUnsent = vi.fn(
    () =>
      new Promise<number>((r) => {
        release = () => r(2);
      }),
  );
  const s = new UploadSweep({ uploads: { sweepUnsent }, log, now: () => new Date(0) });
  const a = s.run();
  const b = s.run();
  expect(a).toBe(b);
  release();
  await a;
  expect(sweepUnsent).toHaveBeenCalledTimes(1);
  expect(log.info).toHaveBeenCalledWith({ count: 2 }, expect.any(String));

  sweepUnsent.mockImplementationOnce(() => Promise.reject(new Error("db down")));
  await expect(s.run()).resolves.toBeUndefined();
  expect(log.error).toHaveBeenCalled();

  s.stop();
  await s.run();
  expect(sweepUnsent).toHaveBeenCalledTimes(2);
  await s.idle();
});

test("start runs on the interval until stopped", async () => {
  vi.useFakeTimers();
  try {
    const sweepUnsent = vi.fn(async () => 0);
    const s = new UploadSweep({
      uploads: { sweepUnsent },
      log,
      now: () => new Date(0),
      interval: 1000,
    });
    s.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(sweepUnsent).toHaveBeenCalledTimes(3);
    s.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(sweepUnsent).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});
