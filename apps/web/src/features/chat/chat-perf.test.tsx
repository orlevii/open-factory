import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
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

/** Markdown renders by source (the only parse a row does) and highlighter warm-ups (U1's pattern). */
const count = vi.hoisted(() => ({ markdown: [] as string[], warm: 0 }));
vi.mock("@/components/markdown/markdown", async (orig) => {
  const m = await orig<typeof import("@/components/markdown/markdown")>();
  return {
    ...m,
    Markdown: (p: Parameters<typeof m.Markdown>[0]) => {
      count.markdown.push(p.source);
      return <m.Markdown {...p} />;
    },
  };
});
vi.mock("@/components/markdown/highlight", async (orig) => ({
  ...(await orig<typeof import("@/components/markdown/highlight")>()),
  warmHighlighter: () => {
    count.warm++;
  },
}));

let thread: ReturnType<typeof chatMsg>[];
let working: { key: string; since: string } | null;
beforeEach(() => {
  count.markdown = [];
  count.warm = 0;
  working = null;
  thread = Array.from({ length: 50 }, (_, i) => (i % 2 ? chatMsg(i + 1) : mine(i + 1)));
  stubChatApi({ chat: () => page(thread, { working }) });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const frame = (qc: Parameters<typeof onChatChanged>[0]) =>
  act(() => onChatChanged(qc, { type: "chat_changed", agent: "dev" }));
const nodes = () => [...document.querySelectorAll("[data-row]")];
/** The principals list arrives after the first paint and re-renders every row once; the tests measure after it. */
const principalsLoaded = (qc: Parameters<typeof onChatChanged>[0]) =>
  waitFor(() => expect(qc.getQueryData(["principals"])).toBeDefined());

test("one new entry renders one row: one markdown, every other row's element kept", async () => {
  const { queryClient } = renderApp("/agents/dev/chat", alice);
  await screen.findByText("Reply 50");
  await principalsLoaded(queryClient);
  const before = nodes();
  expect(before).toHaveLength(50);
  count.markdown = [];
  thread = [...thread, chatMsg(51)];
  frame(queryClient);
  await screen.findByText("Reply 51");
  expect(count.markdown).toEqual(["Reply 51"]);
  const after = nodes();
  expect(after).toHaveLength(51);
  for (let i = 0; i < 50; i++) expect(after[i]).toBe(before[i]);
});

test("a refetch that changes nothing renders no markdown", async () => {
  const { queryClient } = renderApp("/agents/dev/chat", alice);
  await screen.findByText("Reply 50");
  await principalsLoaded(queryClient);
  count.markdown = [];
  frame(queryClient);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
  expect(count.markdown).toEqual([]);
});

test("a pending message turning delivered re-renders only that row", async () => {
  thread = [...thread, mine(51, { state: "pending" })];
  const { queryClient } = renderApp("/agents/dev/chat", alice);
  await screen.findByText("Ask 51");
  await principalsLoaded(queryClient);
  count.markdown = [];
  thread = [...thread.slice(0, 50), mine(51, { state: "delivered" })];
  frame(queryClient);
  await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull());
  expect(count.markdown).toEqual(["Ask 51"]);
});

test("an agent_status frame renders no markdown", async () => {
  const { queryClient } = renderApp("/agents/dev/chat", alice);
  await screen.findByText("Reply 50");
  await principalsLoaded(queryClient);
  count.markdown = [];
  await act(async () => {
    enqueueStatusFrame(queryClient, {
      type: "agent_status",
      agent: "dev",
      status: "working",
      turnOpen: true,
      restartPending: false,
      restartWaitingOn: 0,
      restartChanges: [],
    });
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
  });
  expect(count.markdown).toEqual([]);
});

test("the working line's tick renders no row and no markdown", async () => {
  working = { key: "m1", since: new Date().toISOString() };
  renderApp("/agents/dev/chat", alice);
  await screen.findByText("Reply 50");
  await waitFor(() => expect(document.querySelector("[data-status-line]")).not.toBeNull());
  const line = document.querySelector("[data-status-line]") as HTMLElement;
  const text = line.textContent;
  count.markdown = [];
  await act(async () => {
    await new Promise((r) => setTimeout(r, 2100));
  });
  expect(line.textContent).not.toBe(text);
  expect(count.markdown).toEqual([]);
});

test("the highlighter warms once when the Chat opens", async () => {
  renderApp("/agents/dev/chat", alice);
  await screen.findByText("Reply 50");
  expect(count.warm).toBe(1);
});
