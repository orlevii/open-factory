import type { ServerMessage } from "@open-factory/shared";
import { act, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import type { WsOptions } from "@/lib/ws";
import { useWs, type WsHub } from "@/lib/ws-context";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
const h = vi.hoisted(() => ({
  opts: undefined as WsOptions | undefined,
  sent: [] as unknown[],
  open: false,
  hub: undefined as WsHub | undefined,
}));
vi.mock("@/lib/ws", () => ({
  connectWs: (opts: WsOptions) => {
    h.opts = opts;
    return {
      close() {
        h.open = false;
      },
      status: () => "connecting",
      send: (m: unknown) => {
        if (!h.open) return false;
        h.sent.push(m);
        return true;
      },
    };
  },
}));
// The inbox screen is replaced by a probe that captures the hub the layout provides.
vi.mock("@/components/empty-state", () => ({
  EmptyState: () => {
    const hub = useWs();
    h.hub = hub;
    return <p>probe {hub.openCount}</p>;
  },
}));

beforeEach(() => {
  h.opts = undefined;
  h.sent = [];
  h.open = false;
  h.hub = undefined;
});

const frame = (agent: string): ServerMessage => ({ type: "resync", agent });

test("hub fans frames out to listeners; unsubscribe removes one; send follows the connection", async () => {
  mockApi({ "GET /api/inbox?": () => json({ chats: [], items: [], nextCursor: null }) });
  const { unmount } = renderApp("/inbox", alice);
  await screen.findByText("probe 0");
  const hub = () => h.hub as WsHub;
  const a = vi.fn();
  const b = vi.fn();
  const offA = hub().listen(a);
  hub().listen(b);

  expect(hub().send({ type: "ping" })).toBe(false); // not connected yet
  act(() => {
    h.open = true;
    h.opts?.onOpen?.();
  });
  await screen.findByText("probe 1");
  expect(hub().send({ type: "ping" })).toBe(true);
  expect(h.sent).toEqual([{ type: "ping" }]);

  act(() => h.opts?.onMessage?.(frame("dev")));
  expect(a).toHaveBeenCalledWith(frame("dev"));
  expect(b).toHaveBeenCalledWith(frame("dev"));

  offA();
  act(() => h.opts?.onMessage?.(frame("dev2")));
  expect(a).toHaveBeenCalledTimes(1);
  expect(b).toHaveBeenCalledTimes(2);

  act(() => h.opts?.onOpen?.()); // reconnect
  await screen.findByText("probe 2");

  const send = hub().send;
  unmount();
  expect(send({ type: "ping" })).toBe(false); // cleaned up
});

const status = (agent: string, turnOpen: boolean): ServerMessage =>
  ({
    type: "agent_status",
    agent,
    status: "working",
    turnOpen,
    restartPending: false,
    restartWaitingOn: 0,
  }) as ServerMessage;

async function mounted() {
  mockApi({ "GET /api/inbox?": () => json({ chats: [], items: [], nextCursor: null }) });
  const r = renderApp("/inbox", alice);
  await screen.findByText("probe 0");
  const spy = vi.spyOn(r.queryClient, "invalidateQueries");
  const usage = () => spy.mock.calls.filter(([f]) => f?.queryKey?.[0] === "usage").length;
  return { spy, usage, qc: r.queryClient };
}

test("a turn-closed edge invalidates usage once, 5 s after the first edge; later edges don't extend it", async () => {
  const { usage } = await mounted();
  vi.useFakeTimers();
  try {
    const send = (m: ServerMessage) => act(() => h.opts?.onMessage?.(m));
    send(status("dev", true));
    send(status("dev", true)); // no edge
    send(status("dev", false)); // edge
    expect(usage()).toBe(0);
    vi.advanceTimersByTime(3000);
    send(status("dev", true));
    send(status("dev", false)); // second edge inside the window
    vi.advanceTimersByTime(1999);
    expect(usage()).toBe(0);
    vi.advanceTimersByTime(1); // 5 s after the first edge
    expect(usage()).toBe(1);
    vi.advanceTimersByTime(20_000);
    expect(usage()).toBe(1);
    // A later edge opens a new window.
    send(status("dev", true));
    send(status("dev", false));
    vi.advanceTimersByTime(5000);
    expect(usage()).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});

test("a first false frame is not an edge; the first open invalidates nothing, a reconnect invalidates everything", async () => {
  const { usage, spy } = await mounted();
  act(() => h.opts?.onMessage?.(status("dev", false)));
  expect(usage()).toBe(0);
  act(() => h.opts?.onOpen?.()); // first open: the loaders just fetched
  expect(usage()).toBe(0);
  expect(spy).not.toHaveBeenCalled();
  act(() => h.opts?.onOpen?.()); // reconnect
  // Everything but the chats (they refresh their newest page themselves); only mounted queries refetch.
  const filters = spy.mock.calls[0]?.[0];
  const predicate = filters?.predicate as unknown as (q: { queryKey: unknown[] }) => boolean;
  expect(predicate({ queryKey: ["agents"] })).toBe(true);
  expect(predicate({ queryKey: ["chat", "dev"] })).toBe(false);
});

test("a reconnect refetches the mounted inbox list, and not a first open", async () => {
  const api = mockApi({
    "GET /api/inbox?": () => json({ chats: [], items: [], nextCursor: null }),
  });
  renderApp("/inbox", alice);
  await screen.findByText("probe 0");
  const inboxCalls = () => api.calls.filter((c) => c.url.startsWith("/api/inbox?")).length;
  const before = inboxCalls();
  act(() => h.opts?.onOpen?.()); // first open
  expect(inboxCalls()).toBe(before);
  act(() => h.opts?.onOpen?.()); // reconnect
  await waitFor(() => expect(inboxCalls()).toBe(before + 1));
});

test("a turn open at connect (per the cached agents list) is seen ending", async () => {
  const { usage, qc } = await mounted();
  qc.setQueryData(["agents", "exclude"], [{ slug: "dev", turnOpen: true }]);
  qc.setQueryData(["agents", "only"], [{ slug: "old", turnOpen: false }]);
  vi.useFakeTimers();
  try {
    act(() => h.opts?.onMessage?.(status("old", false))); // cached closed: no edge
    act(() => h.opts?.onMessage?.(status("dev", false))); // cached open: an edge
    vi.advanceTimersByTime(5000);
    expect(usage()).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

test("admin frames invalidate their keys; build log batches don't", async () => {
  const { spy } = await mounted();
  const keys = () => spy.mock.calls.map(([f]) => f?.queryKey?.[0]);
  act(() => h.opts?.onMessage?.({ type: "settings_changed" }));
  act(() => h.opts?.onMessage?.({ type: "users_changed" }));
  expect(keys()).toEqual(expect.arrayContaining(["factory-settings", "users", "invites"]));
  const images = () => keys().filter((k) => k === "images").length;
  act(() =>
    h.opts?.onMessage?.({ type: "image_build", name: "x", state: "building", lines: ["a"] }),
  );
  expect(images()).toBe(0);
  act(() => h.opts?.onMessage?.({ type: "image_build", name: "x", state: "building" }));
  expect(images()).toBe(1);
  act(() => h.opts?.onMessage?.({ type: "images_changed" }));
  expect(images()).toBe(2);
  expect(keys()).toContain("templates");
});

test("config_changed invalidates the agent's and the template's configuration, and that template's agent pages", async () => {
  const { qc } = await mounted();
  const agentCfg = (template: string) => ({ template: { name: template } });
  qc.setQueryData(["agent-config", "ana"], agentCfg("dev"));
  qc.setQueryData(["agent-config", "bo"], agentCfg("ops"));
  qc.setQueryData(["agent-config", "cy"], agentCfg("dev"));
  qc.setQueryData(["template-config", "dev"], {});
  qc.setQueryData(["template-config", "ops"], {});
  const stale = (key: string[]) => qc.getQueryState(key)?.isInvalidated;
  act(() => h.opts?.onMessage?.({ type: "config_changed", agent: "bo" }));
  expect(stale(["agent-config", "bo"])).toBe(true);
  expect(stale(["agent-config", "ana"])).toBe(false);
  expect(stale(["template-config", "ops"])).toBe(false);
  act(() => h.opts?.onMessage?.({ type: "config_changed", template: "dev" }));
  expect(stale(["template-config", "dev"])).toBe(true);
  // The agents on template dev (a template turning broken sends no per-agent frame); not ops's.
  expect(stale(["agent-config", "ana"])).toBe(true);
  expect(stale(["agent-config", "cy"])).toBe(true);
  expect(stale(["template-config", "ops"])).toBe(false);
});

test("unmounting the layout flushes queued status frames and stops listening for visibilitychange", async () => {
  mockApi({ "GET /api/inbox?": () => json({ chats: [], items: [], nextCursor: null }) });
  const { unmount, queryClient: qc } = renderApp("/inbox", alice);
  await screen.findByText("probe 0");
  qc.setQueryData(["agents", "exclude"], [{ slug: "dev", status: "idle", turnOpen: false }]);
  const removed = vi.spyOn(document, "removeEventListener");
  // Queued for the next animation frame, which never runs before the unmount below.
  act(() => h.opts?.onMessage?.(status("dev", true)));
  const listed = () => qc.getQueryData<{ status: string }[]>(["agents", "exclude"])?.[0]?.status;
  expect(listed()).toBe("idle");
  unmount();
  expect(listed()).toBe("working");
  expect(removed.mock.calls.some(([type]) => type === "visibilitychange")).toBe(true);
  removed.mockRestore();
});
