import type { AgentSummary, ServerMessage } from "@open-factory/shared";
import type { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  applyStatusFrames,
  enqueueStatusFrame,
  flushStatusFrames,
  installStatusFrameFlush,
} from "@/features/agents/status-frames";
import { runningQueryKey } from "@/features/session/api";
import { createQueryClient } from "@/lib/query-client";
import { agentSummary } from "@/test/session-fixtures";

type Frame = Extract<ServerMessage, { type: "agent_status" }>;
const frame = (agent: string, status: Frame["status"], over: Partial<Frame> = {}): Frame => ({
  type: "agent_status",
  agent,
  status,
  turnOpen: status === "working",
  restartPending: false,
  restartWaitingOn: 0,
  ...over,
});

let qc: QueryClient;
const list = () => qc.getQueryData<AgentSummary[]>(["agents", "exclude"]) ?? [];
const invalidations = (key: unknown[]) => (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter(
    ([f]) => JSON.stringify((f as { queryKey?: unknown }).queryKey) === JSON.stringify(key),
  ).length;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout"] });
  qc = createQueryClient({ queries: { retry: false } });
  qc.setQueryData(
    ["agents", "exclude"],
    [agentSummary({ slug: "ada", status: "idle" }), agentSummary({ slug: "bob", status: "idle" })],
  );
});
afterEach(() => {
  flushStatusFrames();
  vi.useRealTimers();
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
});

test("frames in one animation frame coalesce: one list write, last frame per slug wins", () => {
  const spy = vi.spyOn(qc, "setQueriesData");
  enqueueStatusFrame(qc, frame("ada", "working"));
  enqueueStatusFrame(qc, frame("ada", "idle"));
  enqueueStatusFrame(qc, frame("bob", "working"));
  expect(spy).not.toHaveBeenCalled();
  vi.advanceTimersToNextFrame();
  expect(spy).toHaveBeenCalledTimes(1);
  expect(list().find((a) => a.slug === "ada")?.status).toBe("idle");
  expect(list().find((a) => a.slug === "bob")?.status).toBe("working");
});

test("unchanged agents keep their object identity", () => {
  qc.setQueryData(["agents", "exclude"], [...list(), agentSummary({ slug: "cy", status: "idle" })]);
  const before = list();
  applyStatusFrames(qc, [frame("ada", "working")]);
  const after = list();
  expect(after.find((a) => a.slug === "ada")).not.toBe(before.find((a) => a.slug === "ada"));
  expect(after.find((a) => a.slug === "bob")).toBe(before.find((a) => a.slug === "bob"));
  expect(after.find((a) => a.slug === "cy")).toBe(before.find((a) => a.slug === "cy"));
});

test("entering terminated is computed against the state before the batch; ['agents'] invalidated once per batch", () => {
  const spy = vi.spyOn(qc, "invalidateQueries");
  applyStatusFrames(qc, [
    frame("ada", "terminated"),
    frame("ada", "terminated"),
    frame("bob", "terminated"),
  ]);
  expect(invalidations(["agents"])(spy)).toBe(1);
  spy.mockClear();
  // Already terminated before this batch: a repeat changes nothing.
  applyStatusFrames(qc, [frame("ada", "terminated")]);
  expect(invalidations(["agents"])(spy)).toBe(0);
});

test("an uncached slug invalidates ['agents'] once per batch, not once per frame", () => {
  const spy = vi.spyOn(qc, "invalidateQueries");
  applyStatusFrames(qc, [frame("new1", "idle"), frame("new2", "idle"), frame("new1", "working")]);
  expect(invalidations(["agents"])(spy)).toBe(1);
  expect(invalidations(["agent", "new1"])(spy)).toBe(1);
  expect(invalidations(["agent", "new2"])(spy)).toBe(1);
});

test("cached detail is patched once per slug; an uncached detail is invalidated", () => {
  qc.setQueryData(["agent", "ada"], { agent: agentSummary({ slug: "ada" }) });
  const spy = vi.spyOn(qc, "setQueryData");
  const inv = vi.spyOn(qc, "invalidateQueries");
  applyStatusFrames(qc, [frame("ada", "working"), frame("ada", "idle"), frame("bob", "idle")]);
  expect(spy.mock.calls.filter(([k]) => (k as string[])[0] === "agent")).toHaveLength(1);
  expect(qc.getQueryData<{ agent: AgentSummary }>(["agent", "ada"])?.agent.status).toBe("idle");
  expect(invalidations(["agent", "bob"])(inv)).toBe(1);
});

test("the newest supervisor frame sets the running count", () => {
  applyStatusFrames(qc, [
    { type: "supervisor", running: 1, max: 8 },
    { type: "supervisor", running: 3, max: 8 },
  ]);
  expect(qc.getQueryData(runningQueryKey)).toEqual({ count: 3, max: 8 });
});

test("other message types are ignored", () => {
  const spy = vi.spyOn(qc, "setQueriesData");
  enqueueStatusFrame(qc, { type: "inbox_changed" } as ServerMessage);
  vi.advanceTimersByTime(500);
  expect(spy).not.toHaveBeenCalled();
});

test("hidden document flushes on a 100ms timeout; visibilitychange flushes at once", () => {
  Object.defineProperty(document, "hidden", { value: true, configurable: true });
  const off = installStatusFrameFlush();
  enqueueStatusFrame(qc, frame("ada", "working"));
  vi.advanceTimersByTime(99);
  expect(list()[0]?.status).toBe("idle");
  vi.advanceTimersByTime(1);
  expect(list()[0]?.status).toBe("working");

  enqueueStatusFrame(qc, frame("ada", "idle"));
  document.dispatchEvent(new Event("visibilitychange"));
  expect(list()[0]?.status).toBe("idle");
  off();
});

test("unmounting the shell drops pending frames", () => {
  const off = installStatusFrameFlush();
  enqueueStatusFrame(qc, frame("ada", "working"));
  off();
  vi.advanceTimersByTime(500);
  expect(list()[0]?.status).toBe("idle");
});
