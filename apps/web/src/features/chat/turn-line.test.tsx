import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { enqueueStatusFrame } from "@/features/agents/status-frames";
import { chatMsg, mine, page, stubChatApi } from "@/test/chat-fixtures";
import { alice, renderApp } from "@/test/render-app";
import { onChatChanged } from "./use-chat";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: (o: { onStatus?: (s: string) => void; onOpen?: () => void }) => {
    setTimeout(() => {
      o.onStatus?.("open");
      o.onOpen?.();
    }, 0);
    return { close() {}, status: () => "open", send: () => true };
  },
}));
afterEach(() => vi.unstubAllGlobals());

const outcome = (over = {}) =>
  ({
    kind: "turn_outcome",
    key: "m1",
    turnId: "t1",
    endedAt: "2026-11-23T14:02:00.000Z",
    eventSeq: 7,
    outcome: "no_reply",
    ...over,
  }) as const;
const lineEl = () => document.querySelector<HTMLElement>("[data-status-line]");
const frame = (qc: Parameters<typeof onChatChanged>[0]) =>
  act(() => onChatChanged(qc, { type: "chat_changed", agent: "dev" }));
const since = () => new Date(Date.now() - 42_000).toISOString();

test("the working line is the thread's last row: duration first and tabular, then the name, then the link", async () => {
  stubChatApi({
    chat: () => page([mine(1), chatMsg(2)], { working: { key: "m1", since: since() } }),
  });
  renderApp("/agents/dev/chat", alice);
  await screen.findByText("Reply 2");
  const line = await waitFor(() => {
    const el = lineEl();
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });
  expect(line).toHaveTextContent(/^4\ds · Dev agent.*is working · Open session$/);
  expect(line.firstElementChild?.nextElementSibling).toHaveClass("tabular-nums", "shrink-0");
  expect(line.nextElementSibling).toBeNull();
  // At large text the line wraps (the link unit under the sentence) rather than overflowing; never a fixed height.
  expect(line).toHaveClass("min-h-6", "flex-wrap");
  expect(line).not.toHaveClass("h-6");
  expect(within(line).getByRole("link").parentElement).toHaveClass("shrink-0", "whitespace-nowrap");
  const link = within(line).getByRole("link", { name: /^Open session at \d\d:\d\d$/ });
  expect(link).toHaveClass("shrink-0");
});

test("status frames never hide the working line", async () => {
  stubChatApi({ chat: () => page([mine(1)], { working: { key: "m1", since: since() } }) });
  const { queryClient } = renderApp("/agents/dev/chat", alice);
  await waitFor(() => expect(lineEl()).not.toBeNull());
  const line = lineEl();
  await act(async () => {
    enqueueStatusFrame(queryClient, {
      type: "agent_status",
      agent: "dev",
      status: "idle",
      turnOpen: false,
      restartPending: false,
      restartWaitingOn: 0,
      restartChanges: [],
    });
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
  });
  expect(lineEl()).toBe(line);
});

test("a working line that appears live fades in; its outcome is the same node", async () => {
  let state: "idle" | "working" | "done" = "idle";
  stubChatApi({
    chat: () =>
      state === "idle"
        ? page([mine(1)])
        : state === "working"
          ? page([mine(1)], { working: { key: "m1", since: since() } })
          : page([mine(1), outcome()]),
  });
  const { queryClient } = renderApp("/agents/dev/chat", alice);
  await screen.findByText("Ask 1");
  expect(lineEl()).toBeNull();
  state = "working";
  frame(queryClient);
  await waitFor(() => expect(lineEl()).not.toBeNull());
  const line = lineEl() as HTMLElement;
  expect(line).toHaveAttribute("data-live");
  state = "done";
  frame(queryClient);
  await waitFor(() => expect(lineEl()).toHaveAttribute("data-status-line", "no_reply"));
  expect(lineEl()).toBe(line);
  // The link keeps its x: the same anatomy, the same gutter.
  expect(
    within(line).getByRole("link", { name: /^Open session at \d\d:\d\d$/ }),
  ).toBeInTheDocument();
});

test("when the agent replied, the working line goes in the commit that brings the reply", async () => {
  let replied = false;
  stubChatApi({
    chat: () =>
      replied
        ? page([mine(1), chatMsg(2)])
        : page([mine(1)], { working: { key: "m1", since: since() } }),
  });
  const { queryClient } = renderApp("/agents/dev/chat", alice);
  await waitFor(() => expect(lineEl()).not.toBeNull());
  const seen: boolean[] = [];
  const watch = new MutationObserver(() => {
    if (screen.queryByText("Reply 2")) seen.push(lineEl() !== null);
  });
  watch.observe(document.body, { childList: true, subtree: true });
  replied = true;
  frame(queryClient);
  await screen.findByText("Reply 2");
  watch.disconnect();
  expect(lineEl()).toBeNull();
  expect(seen.length).toBeGreaterThan(0);
  expect(seen).not.toContain(true);
});

test("a long name leaves the duration and the link whole", async () => {
  stubChatApi({
    chat: () => page([mine(1)], { working: { key: "m1", since: since() } }),
    agent: { displayName: "A very long agent display name that cannot fit on a phone screen" },
  });
  renderApp("/agents/dev/chat", alice);
  const line = await waitFor(() => {
    const el = lineEl();
    expect(el).toHaveTextContent("is working");
    return el as HTMLElement;
  });
  expect(line).toHaveClass("min-w-0");
  expect(line.querySelector(".tabular-nums")).toHaveClass("shrink-0");
  expect(within(line).getByRole("link")).toHaveClass("shrink-0");
});
