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
import { refFor } from "@/test/refs";
import { agentSummary } from "@/test/session-fixtures";

type Frame = Extract<ServerMessage, { type: "agent_status" }>;
const frame = (agent: string, status: Frame["status"], over: Partial<Frame> = {}): Frame => ({
  type: "agent_status",
  agent: refFor(agent),
  status,
  turnOpen: status === "working",
  restartPending: false,
  restartWaitingOn: 0,
  restartChanges: [],
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
    [
      agentSummary({ handle: "ada", status: "idle" }),
      agentSummary({ handle: "bob", status: "idle" }),
    ],
  );
});
afterEach(() => {
  flushStatusFrames();
  vi.useRealTimers();
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
});

test("frames in one animation frame coalesce: one list write, last frame per handle wins", () => {
  const spy = vi.spyOn(qc, "setQueriesData");
  enqueueStatusFrame(qc, frame("ada", "working"));
  enqueueStatusFrame(qc, frame("ada", "idle"));
  enqueueStatusFrame(qc, frame("bob", "working"));
  expect(spy).not.toHaveBeenCalled();
  vi.advanceTimersToNextFrame();
  expect(spy).toHaveBeenCalledTimes(1);
  expect(list().find((a) => a.handle === "ada")?.status).toBe("idle");
  expect(list().find((a) => a.handle === "bob")?.status).toBe("working");
});

test("unchanged agents keep their object identity", () => {
  qc.setQueryData(
    ["agents", "exclude"],
    [...list(), agentSummary({ handle: "cy", status: "idle" })],
  );
  const before = list();
  applyStatusFrames(qc, [frame("ada", "working")]);
  const after = list();
  expect(after.find((a) => a.handle === "ada")).not.toBe(before.find((a) => a.handle === "ada"));
  expect(after.find((a) => a.handle === "bob")).toBe(before.find((a) => a.handle === "bob"));
  expect(after.find((a) => a.handle === "cy")).toBe(before.find((a) => a.handle === "cy"));
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

test("an uncached handle invalidates ['agents'] once per batch, not once per frame", () => {
  const spy = vi.spyOn(qc, "invalidateQueries");
  applyStatusFrames(qc, [frame("new1", "idle"), frame("new2", "idle"), frame("new1", "working")]);
  expect(invalidations(["agents"])(spy)).toBe(1);
  expect(invalidations(["agent", refFor("new1")])(spy)).toBe(1);
  expect(invalidations(["agent", refFor("new2")])(spy)).toBe(1);
});

test("cached detail is patched once per handle; an uncached detail is invalidated", () => {
  qc.setQueryData(["agent", refFor("ada")], { agent: agentSummary({ handle: "ada" }) });
  const spy = vi.spyOn(qc, "setQueryData");
  const inv = vi.spyOn(qc, "invalidateQueries");
  applyStatusFrames(qc, [frame("ada", "working"), frame("ada", "idle"), frame("bob", "idle")]);
  expect(spy.mock.calls.filter(([k]) => (k as string[])[0] === "agent")).toHaveLength(1);
  expect(qc.getQueryData<{ agent: AgentSummary }>(["agent", refFor("ada")])?.agent.status).toBe(
    "idle",
  );
  expect(invalidations(["agent", refFor("bob")])(inv)).toBe(1);
});

test("the newest supervisor frame sets the running count", () => {
  applyStatusFrames(qc, [
    { type: "supervisor", running: 1 },
    { type: "supervisor", running: 3 },
  ]);
  expect(qc.getQueryData(runningQueryKey)).toEqual({ count: 3 });
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

test("teardown flushes pending frames and removes the visibilitychange listener", () => {
  const off = installStatusFrameFlush();
  enqueueStatusFrame(qc, frame("ada", "working"));
  off();
  expect(list()[0]?.status).toBe("working");
  enqueueStatusFrame(qc, frame("ada", "idle"));
  document.dispatchEvent(new Event("visibilitychange"));
  // The listener is gone: only the scheduled frame flushes it.
  expect(list()[0]?.status).toBe("working");
  vi.advanceTimersToNextFrame();
  expect(list()[0]?.status).toBe("idle");
});

test("a pending animation frame is flushed when the tab turns hidden (visibilitychange)", () => {
  const off = installStatusFrameFlush();
  enqueueStatusFrame(qc, frame("ada", "working"));
  Object.defineProperty(document, "hidden", { value: true, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
  expect(list()[0]?.status).toBe("working");
  off();
});

test("a frame without lastError clears it, in the list and the detail", () => {
  const withErr = agentSummary({ handle: "ada", status: "errored", lastError: "boom" });
  qc.setQueryData(["agents", "exclude"], [withErr]);
  qc.setQueryData(["agent", refFor("ada")], { agent: withErr });
  applyStatusFrames(qc, [frame("ada", "idle")]);
  expect(list()[0]?.lastError).toBeUndefined();
  expect(
    qc.getQueryData<{ agent: AgentSummary }>(["agent", refFor("ada")])?.agent.lastError,
  ).toBeUndefined();
});

test("restartPending and restartWaitingOn fold into the list and the detail", () => {
  qc.setQueryData(["agent", refFor("ada")], { agent: agentSummary({ handle: "ada" }) });
  applyStatusFrames(qc, [frame("ada", "idle", { restartPending: true, restartWaitingOn: 2 })]);
  expect(list()[0]).toMatchObject({ restartPending: true, restartWaitingOn: 2 });
  expect(qc.getQueryData<{ agent: AgentSummary }>(["agent", refFor("ada")])?.agent).toMatchObject({
    restartPending: true,
    restartWaitingOn: 2,
    restartChanges: [],
  });
});

test("every cached list variant is patched, others untouched", () => {
  qc.setQueryData(["agents", "only"], [agentSummary({ handle: "ada", status: "working" })]);
  qc.setQueryData(["agents", "include"], [agentSummary({ handle: "ada", status: "working" })]);
  const other = agentSummary({ handle: "zed", status: "idle" });
  qc.setQueryData(["agents", "other"], [other]);
  applyStatusFrames(qc, [frame("ada", "idle", { restartPending: true, restartWaitingOn: 1 })]);
  for (const v of ["exclude", "only", "include"]) {
    const row = qc.getQueryData<AgentSummary[]>(["agents", v])?.find((a) => a.handle === "ada");
    expect(row, v).toMatchObject({ status: "idle", restartWaitingOn: 1 });
  }
  expect(qc.getQueryData<AgentSummary[]>(["agents", "other"])?.[0]).toBe(other);
});
