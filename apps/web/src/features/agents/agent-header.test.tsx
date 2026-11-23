import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
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
const header = vi.hoisted(() => ({ renders: 0, mounts: 0 }));
vi.mock("@/components/page-header", async (orig) => {
  const m = await orig<typeof import("@/components/page-header")>();
  const { createElement, useEffect } = await import("react");
  return {
    ...m,
    PageHeader: (p: ComponentProps<typeof m.PageHeader>) => {
      header.renders++;
      // biome-ignore lint/correctness/useExhaustiveDependencies: counts mounts only
      useEffect(() => {
        header.mounts++;
      }, []);
      return createElement(m.PageHeader, p);
    },
  };
});

const json = (data: unknown) =>
  new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
let agent: Parameters<typeof detail>[0];
beforeEach(() => {
  agent = {};
  header.renders = 0;
  header.mounts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.startsWith("/api/agents/dev/chat"))
        return json({ entries: [], nextCursor: null, newerCursor: null, working: null });
      if (url.startsWith("/api/agents/dev/events")) return json(conversation());
      if (url === "/api/agents/dev") return json(detail(agent));
      if (url.startsWith("/api/agents?"))
        return json({ agents: [detail(agent).agent], more: false, running: { count: 0, max: 8 } });
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
  const { router } = renderApp("/agents/dev/chat", alice);
  const toSession = await waitFor(async () => {
    const l = await switchLink();
    expect(l).toHaveAccessibleName("Session");
    return l;
  });
  expect(toSession.querySelector(".lucide-square-terminal")).not.toBeNull();
  expect(toSession).toHaveAttribute("href", "/agents/dev/session");
  await userEvent.click(toSession);
  await waitFor(() => expect(router.state.location.pathname).toBe("/agents/dev/session"));
  const toChat = await waitFor(async () => {
    const l = await switchLink();
    expect(l).toHaveAccessibleName("Chat");
    return l;
  });
  expect(toChat.querySelector(".lucide-message-square")).not.toBeNull();
  expect(toChat).toHaveAttribute("href", "/agents/dev/chat");
});

test("the slot keeps the width of the wider label in both views, and only the icon shows below 24rem", async () => {
  renderApp("/agents/dev/session", alice);
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
  expect(cell.children[1]).toHaveClass("invisible");
  // Below a 24rem header the label is for screen readers only (the accessible name is on the link).
  expect(cell).toHaveClass("@max-[24rem]:sr-only");
  expect(link).toHaveAccessibleName("Chat");
});

test("crowded by Restart, the switch leaves the header below 22rem too; Restart stays", async () => {
  agent = { status: "errored", lastError: "boom" };
  renderApp("/agents/dev/chat", alice);
  const link = await waitFor(async () => {
    const l = await switchLink();
    expect(l).toHaveAccessibleName("Session");
    return l;
  });
  expect(link).toHaveClass("@max-[22rem]:hidden");
  const bar = await banner();
  expect(within(bar).getByRole("button", { name: "Restart" })).toBeInTheDocument();
  await userEvent.click(within(bar).getByRole("button", { name: "Actions for Dev agent" }));
  const items = await screen.findAllByRole("menuitem");
  expect(items[0]).toHaveTextContent("Open session");
  expect(items[0]).toHaveAttribute("href", "/agents/dev/session");
});

test("uncrowded, the switch also leaves the header below 22rem (which is a phone, or 200% text) and tops the ⋯ menu", async () => {
  renderApp("/agents/dev/chat", alice);
  const link = await switchLink();
  expect(link).toHaveClass("@max-[22rem]:hidden");
  // The name clips itself inside the h1 (block + truncate) and the h1's floor drops to 1.5rem below 22rem, so the
  // ⋯ stays inside a 390px phone at 200% text.
  const h1 = (await banner()).querySelector("h1");
  expect(h1).toHaveClass("truncate", "@max-[22rem]:min-w-6");
  expect(h1?.firstElementChild).toHaveClass("block", "min-w-0", "truncate");
  await userEvent.click(
    within(await banner()).getByRole("button", { name: "Actions for Dev agent" }),
  );
  const items = await screen.findAllByRole("menuitem");
  expect(items[0]).toHaveTextContent("Open session");
});

test("the live fact's Open session link is in the Chat and hidden in the Session", async () => {
  agent = { status: "errored", lastError: "boom" };
  const { router } = renderApp("/agents/dev/chat", alice);
  const bar = await banner();
  const open = await within(bar).findByRole("link", { name: "Open session" });
  expect(open).toHaveAttribute("href", "/agents/dev/session");
  await act(() => router.navigate({ to: "/agents/$slug/session", params: { slug: "dev" } }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/agents/dev/session"));
  expect(await within(await banner()).findByText("boom")).toBeInTheDocument();
  expect(within(await banner()).queryByRole("link", { name: "Open session" })).toBeNull();
});

test("the header does not remount across a switch", async () => {
  const { router } = renderApp("/agents/dev/chat", alice);
  await waitFor(() => expect(header.mounts).toBe(1));
  await userEvent.click(await switchLink());
  await waitFor(() => expect(router.state.location.pathname).toBe("/agents/dev/session"));
  await screen.findByText("Two entries.");
  fireEvent.click(await switchLink());
  await waitFor(() => expect(router.state.location.pathname).toBe("/agents/dev/chat"));
  expect(header.mounts).toBe(1);
});
