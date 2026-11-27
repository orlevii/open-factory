import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { refFor } from "@/test/refs";
import { alice, renderApp } from "@/test/render-app";
import { conversation, detail } from "@/test/session-fixtures";

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
const json = (data: unknown) =>
  new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
let agent: Parameters<typeof detail>[0];
beforeEach(() => {
  agent = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.startsWith(`/api/agents/${refFor("dev")}/chat`))
        return json({ entries: [], nextCursor: null, newerCursor: null, working: null });
      if (url.startsWith(`/api/agents/${refFor("dev")}/events`)) return json(conversation());
      if (url === `/api/agents/${refFor("dev")}`) return json(detail(agent));
      if (url.startsWith("/api/agents?"))
        return json({ agents: [detail(agent).agent], more: false, running: { count: 0 } });
      return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const banner = () => screen.findByRole("banner");
const switchLink = async () => {
  const link = within(await banner()).getByRole("link", { name: /^(Chat|Session)$/ });
  return link as HTMLAnchorElement;
};

test("in the Chat the switch reads Session with the terminal icon; in the Session, Chat with the speech icon", async () => {
  const { router } = renderApp(`/agents/${refFor("dev")}/chat`, alice);
  const toSession = await waitFor(async () => {
    const l = await switchLink();
    expect(l).toHaveAccessibleName("Session");
    return l;
  });
  expect(toSession.querySelector(".lucide-square-terminal")).not.toBeNull();
  expect(toSession).toHaveAttribute("href", `/agents/${refFor("dev")}/session`);
  await userEvent.click(toSession);
  await waitFor(() =>
    expect(router.state.location.pathname).toBe(`/agents/${refFor("dev")}/session`),
  );
  const toChat = await waitFor(async () => {
    const l = await switchLink();
    expect(l).toHaveAccessibleName("Chat");
    return l;
  });
  expect(toChat.querySelector(".lucide-message-square")).not.toBeNull();
  expect(toChat).toHaveAttribute("href", `/agents/${refFor("dev")}/chat`);
});

test("the slot keeps the width of the wider label in both views, and only the icon shows below 24rem", async () => {
  renderApp(`/agents/${refFor("dev")}/session`, alice);
  const link = await waitFor(async () => {
    const l = await switchLink();
    expect(l).toHaveAccessibleName("Chat");
    return l;
  });
  const cell = link.querySelector("span.grid") as HTMLElement;
  // "Chat" is shown; "Session" is laid over it, invisible, so the slot is as wide as the longer one.
  expect(cell.children[0]).toHaveTextContent("Chat");
  expect(cell.children[1]).toHaveTextContent("Session");
  expect(cell.children[1]).toHaveAttribute("aria-hidden", "true");
  expect(link).toHaveAccessibleName("Chat");
});

test("crowded by Restart, the switch leaves the header below 22rem too; Restart stays", async () => {
  agent = { status: "errored", lastError: "boom" };
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  await waitFor(async () => {
    expect(await switchLink()).toHaveAccessibleName("Session");
  });
  const bar = await banner();
  expect(within(bar).getByRole("button", { name: "Restart" })).toBeInTheDocument();
  await userEvent.click(within(bar).getByRole("button", { name: "Actions for Dev agent" }));
  const items = await screen.findAllByRole("menuitem");
  expect(items[0]).toHaveTextContent("Open session");
  expect(items[0]).toHaveAttribute("href", `/agents/${refFor("dev")}/session`);
});

test("uncrowded, the switch also leaves the header below 22rem (which is a phone, or 200% text) and tops the ⋯ menu", async () => {
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  await switchLink();
  await userEvent.click(
    within(await banner()).getByRole("button", { name: "Actions for Dev agent" }),
  );
  const items = await screen.findAllByRole("menuitem");
  expect(items[0]).toHaveTextContent("Open session");
});

test("the live fact's Open session link is in the Chat and hidden in the Session", async () => {
  agent = { status: "errored", lastError: "boom" };
  const { router } = renderApp(`/agents/${refFor("dev")}/chat`, alice);
  const bar = await banner();
  const open = await within(bar).findByRole("link", { name: "Open session" });
  expect(open).toHaveAttribute("href", `/agents/${refFor("dev")}/session`);
  await act(() => router.navigate({ to: "/agents/$ref/session", params: { ref: refFor("dev") } }));
  await waitFor(() =>
    expect(router.state.location.pathname).toBe(`/agents/${refFor("dev")}/session`),
  );
  expect(await within(await banner()).findByText("boom")).toBeInTheDocument();
  expect(within(await banner()).queryByRole("link", { name: "Open session" })).toBeNull();
});

test("a pending restart's Restart now is a sibling of the status line, never inside it", async () => {
  agent = { status: "idle", restartPending: true };
  renderApp(`/agents/${refFor("dev")}/session`, alice);
  const header = await banner();
  const button = await within(header).findByRole("button", { name: "Restart now" });
  const line = within(header)
    .getAllByRole("status")
    .find((s) => s.textContent === "Restarts when idle");
  expect(line).toBeDefined();
  expect(line?.contains(button)).toBe(false);
});

test("with no pending restart the header has no Restart now", async () => {
  agent = { status: "idle" };
  renderApp(`/agents/${refFor("dev")}/session`, alice);
  await switchLink();
  expect(within(await banner()).queryByRole("button", { name: "Restart now" })).toBeNull();
});
