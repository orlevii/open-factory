import type { ServerMessage } from "@open-factory/shared";
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json, mockApi } from "@/test/mock-api";
import { refFor } from "@/test/refs";
import { alice, renderApp } from "@/test/render-app";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
const ws = vi.hoisted(() => ({
  onMessage: undefined as undefined | ((m: ServerMessage) => void),
}));
vi.mock("@/lib/ws", () => ({
  connectWs: (o: { onMessage?: (m: ServerMessage) => void; onOpen?: () => void }) => {
    ws.onMessage = o.onMessage;
    setTimeout(() => o.onOpen?.(), 0);
    return { close() {}, status: () => "open", send: () => true };
  },
}));
const originalMatchMedia = window.matchMedia;
afterEach(() => {
  window.matchMedia = originalMatchMedia;
  vi.unstubAllGlobals();
});

const hold = (resumedAt: string | null) => ({
  id: "h1",
  agents: [
    { ref: refFor("a"), handle: "a", status: "live" },
    { ref: refFor("b"), handle: "b", status: "live" },
  ],
  waiting: 2,
  sentOn: 0,
  resumedAt,
  resumedBy: resumedAt ? { ref: refFor("ana"), handle: "ana" } : null,
});
const item = (resumedAt: string | null) => ({
  id: "i1",
  messageId: "m1",
  kind: "notice",
  read: true,
  from: { kind: "factory" },
  about: "a",
  to: "@alice",
  preview: "@a and @b exchanged 22 messages in 3 minutes; further messages between them are held.",
  urgent: false,
  createdAt: new Date().toISOString(),
  notice: "loop_held",
  loopHold: hold(resumedAt),
  link: { kind: "session", agentRef: refFor("a") },
});

test("a hold row says Held, then Resumed once inbox_changed brings resumedAt", async () => {
  fakeMatchMedia.installWidth(1280);
  let current = item(null);
  mockApi({
    "GET /api/inbox?": () => json({ chats: [], items: [current], nextCursor: null }),
    "GET /api/inbox/unread-count": () => json({ count: 0, byAgent: {} }),
  });
  renderApp("/inbox", alice);
  const link = await screen.findByRole("link", { name: /From Factory about @a/ });
  expect(link).toHaveAccessibleName(/held/);
  expect(link).toHaveTextContent("Held");
  current = item(new Date().toISOString());
  act(() => ws.onMessage?.({ type: "inbox_changed" }));
  await waitFor(() =>
    expect(screen.getByRole("link", { name: /resumed/ })).toHaveTextContent("Resumed"),
  );
  expect(screen.getByRole("link", { name: /resumed/ })).not.toHaveTextContent("Held");
});
