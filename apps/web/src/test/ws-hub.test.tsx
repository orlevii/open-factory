import type { ServerMessage } from "@open-factory/shared";
import { act, screen } from "@testing-library/react";
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
  mockApi({ "GET /api/inbox?": () => json({ items: [], nextCursor: null }) });
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
  mockApi({ "GET /api/inbox?": () => json({ items: [], nextCursor: null }) });
  const r = renderApp("/inbox", alice);
  await screen.findByText("probe 0");
  const spy = vi.spyOn(r.queryClient, "invalidateQueries");
  const usage = () => spy.mock.calls.filter(([f]) => f?.queryKey?.[0] === "usage").length;
  return { spy, usage };
}

test("a turn-closed edge invalidates usage once after 5 s; two edges inside it invalidate once", async () => {
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
    vi.advanceTimersByTime(4999);
    expect(usage()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(usage()).toBe(1);
    vi.advanceTimersByTime(20_000);
    expect(usage()).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

test("a first false frame is not an edge; reconnect invalidates usage", async () => {
  const { usage } = await mounted();
  act(() => h.opts?.onMessage?.(status("dev", false)));
  expect(usage()).toBe(0);
  act(() => h.opts?.onOpen?.());
  expect(usage()).toBe(1);
});

test("admin frames invalidate their keys", async () => {
  const { spy } = await mounted();
  const keys = () => spy.mock.calls.map(([f]) => f?.queryKey?.[0]);
  act(() => h.opts?.onMessage?.({ type: "settings_changed" }));
  act(() => h.opts?.onMessage?.({ type: "users_changed" }));
  act(() => h.opts?.onMessage?.({ type: "images_changed" }));
  act(() => h.opts?.onMessage?.({ type: "image_build", name: "x", state: "building" }));
  expect(keys()).toEqual(
    expect.arrayContaining(["factory-settings", "users", "invites", "images", "templates"]),
  );
});
