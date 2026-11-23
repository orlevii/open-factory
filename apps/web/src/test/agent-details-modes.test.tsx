import type { ServerMessage } from "@open-factory/shared";
import { act, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useShortcut } from "@/lib/shortcuts";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { conversation, detail } from "@/test/session-fixtures";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: (o: { onOpen?: () => void; onStatus?: (s: string) => void }) => {
    setTimeout(() => {
      o.onStatus?.("open");
      o.onOpen?.();
    }, 0);
    return { close() {}, status: () => "open", send: (_: ServerMessage) => true };
  },
}));

const original = window.matchMedia;
beforeEach(() => {
  localStorage.clear();
  mockApi({
    "GET /api/agents/dev": () => json(detail()),
    "GET /api/agents/dev/events?": () => json(conversation()),
    "GET /api/agents/lead": () => json(detail({ slug: "lead", displayName: "Lead agent" })),
    "GET /api/agents/lead/events?": () => json(conversation()),
  });
});
afterEach(() => {
  window.matchMedia = original;
  vi.unstubAllGlobals();
  // Radix can leave its modal marks on <body> when a test ends with a drawer open.
  document.body.style.pointerEvents = "";
});

async function visit(width: number, path = "/agents/dev/session") {
  const viewport = fakeMatchMedia.installWidth(width);
  const app = renderApp(path, alice);
  await screen.findByText("Two entries.");
  return { ...app, viewport };
}

const toggle = () => screen.getByRole("button", { name: "Agent details" });
const container = () => document.getElementById("agent-details");
function modeOf(el: HTMLElement | null) {
  if (!el) return null;
  if (el.tagName === "ASIDE") return "inflow";
  if (el.dataset.slot === "sheet-content") return "overlay";
  if (el.dataset.slot === "drawer-content") return "drawer";
  return "unknown";
}

test.each([
  [1440, "inflow", true],
  [1280, "inflow", true],
  [1279, "inflow", false],
  [1024, "inflow", false],
  [1023, "overlay", false],
  [768, "overlay", false],
  [767, "drawer", false],
] as const)("at %ipx the mode is %s, open by default = %s", async (w, mode, open) => {
  await visit(w);
  expect(container() !== null).toBe(open);
  expect(toggle()).toHaveAttribute("aria-expanded", String(open));
  if (!open) await userEvent.click(toggle());
  await waitFor(() => expect(modeOf(container())).toBe(mode));
  expect(within(container() as HTMLElement).getByText("@dev")).toBeInTheDocument();
});

test("the 7-day usage is fetched only once Agent details opens", async () => {
  const api = mockApi({
    "GET /api/agents/dev": () => json(detail()),
    "GET /api/agents/dev/events?": () => json(conversation()),
    "GET /api/usage/agents?": () => json({ agents: [] }),
  });
  const usageCalls = () => api.calls.filter((c) => c.url.startsWith("/api/usage/agents"));
  await visit(1100);
  expect(container()).toBeNull();
  expect(usageCalls()).toEqual([]);
  await userEvent.click(toggle());
  await waitFor(() => expect(usageCalls()).toHaveLength(1));
  expect(usageCalls()[0]?.url).toBe("/api/usage/agents?window=rolling");
});

test("≥1280 the choice is remembered (of-agent-details); 1024–1279 starts closed on every visit", async () => {
  const first = await visit(1440);
  await userEvent.click(toggle());
  expect(container()).toBeNull();
  expect(localStorage.getItem("of-agent-details")).toBe("closed");
  first.unmount();

  const second = await visit(1440);
  expect(container()).toBeNull();
  await userEvent.click(toggle());
  expect(localStorage.getItem("of-agent-details")).toBe("open");
  second.unmount();

  localStorage.clear();
  const narrow = await visit(1100);
  await userEvent.click(toggle());
  expect(modeOf(container())).toBe("inflow");
  // Not remembered below 1280.
  expect(localStorage.getItem("of-agent-details")).toBeNull();
  narrow.unmount();
  await visit(1100);
  expect(container()).toBeNull();
});

test.each([1440, 1100, 900])(
  "] and the header toggle open and close it at %ipx; aria-expanded follows",
  async (w) => {
    await visit(w);
    const startsOpen = w >= 1280;
    const user = userEvent.setup();
    await user.keyboard("]");
    await waitFor(() => expect(container() !== null).toBe(!startsOpen));
    expect(toggle()).toHaveAttribute("aria-expanded", String(!startsOpen));
    await user.click(toggle());
    await waitFor(() => expect(container() !== null).toBe(startsOpen));
    expect(toggle()).toHaveAttribute("aria-expanded", String(startsOpen));
    expect(toggle()).toHaveAttribute("aria-controls", "agent-details");
  },
);

test("below 768, ] opens the drawer and closes it again; other keys stay blocked behind it", async () => {
  await visit(767);
  const other = vi.fn();
  renderHook(() => useShortcut("c", other));
  const user = userEvent.setup();
  await user.keyboard("]");
  await waitFor(() => expect(modeOf(container())).toBe("drawer"));
  // The drawer is modal: the page's other shortcuts stay blocked behind it.
  await user.keyboard("c");
  expect(other).not.toHaveBeenCalled();
  await user.keyboard("]");
  // The modal drawer hides the page from the accessibility tree, so the toggle is read by id; Vaul
  // keeps the content mounted while it animates out.
  const toggleEl = document.getElementById("agent-details-toggle");
  await waitFor(() => expect(toggleEl).toHaveAttribute("aria-expanded", "false"));
  expect(container()?.getAttribute("data-state") ?? "closed").toBe("closed");
});

test("the overlay sits below the header: Stop and the toggle stay clickable", async () => {
  vi.unstubAllGlobals();
  const api = mockApi({
    "GET /api/agents/dev": () => json(detail({ status: "working", turnOpen: true })),
    "GET /api/agents/dev/events?": () => json(conversation()),
    "POST /api/agents/dev/interrupt": () => json({}, 202),
  });
  await visit(900);
  await userEvent.click(toggle());
  await waitFor(() => expect(modeOf(container())).toBe("overlay"));
  const sheet = container() as HTMLElement;
  expect(sheet).not.toHaveAttribute("aria-modal");
  // Still in the accessibility tree and clickable (a modal would hide the page behind).
  await userEvent.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() =>
    expect(api.calls.filter((c) => c.url === "/api/agents/dev/interrupt")).toHaveLength(1),
  );
  await userEvent.click(toggle());
  await waitFor(() => expect(container()).toBeNull());
});

test("switching agents keeps an open panel open (≥1024) and retargets the overlay in place", async () => {
  const wide = await visit(1100);
  await userEvent.click(toggle());
  await act(() => wide.router.navigate({ to: "/agents/$slug/session", params: { slug: "lead" } }));
  await screen.findByRole("heading", { level: 1, name: "Lead agent" });
  await waitFor(() => expect(within(container() as HTMLElement).getByText("@lead")).toBeTruthy());
  expect(modeOf(container())).toBe("inflow");
  wide.unmount();

  const mid = await visit(900);
  await userEvent.click(toggle());
  await waitFor(() => expect(modeOf(container())).toBe("overlay"));
  const sheet = container();
  await act(() => mid.router.navigate({ to: "/agents/$slug/session", params: { slug: "lead" } }));
  await screen.findByRole("heading", { level: 1, name: "Lead agent" });
  await waitFor(() => expect(within(container() as HTMLElement).getByText("@lead")).toBeTruthy());
  // The same sheet node: its content swapped in place, it never closed and reopened.
  expect(container()).toBe(sheet);
});

test("at 900px, Agent details from the ⋯ menu moves focus into the opened sheet", async () => {
  await visit(900);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Actions for Dev agent" }));
  await user.click(await screen.findByRole("menuitem", { name: /^Agent details/ }));
  await waitFor(() => expect(modeOf(container())).toBe("overlay"));
  await waitFor(() => expect(container()?.contains(document.activeElement)).toBe(true));
  // And it stays there once the menu has finished closing.
  await new Promise((r) => setTimeout(r, 50));
  expect(container()?.contains(document.activeElement)).toBe(true);
});

test("at 900px, Esc in the composer closes the peek and leaves focus in the composer", async () => {
  await visit(900);
  const user = userEvent.setup();
  await user.click(toggle());
  await waitFor(() => expect(modeOf(container())).toBe("overlay"));
  const box = screen.getByRole("combobox", { name: "Message to Dev agent" });
  await user.click(box);
  expect(box).toHaveFocus();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(container()).toBeNull());
  await new Promise((r) => setTimeout(r, 50));
  expect(box).toHaveFocus();
});

test("at 900px, closing the peek from inside it returns focus to the toggle", async () => {
  await visit(900);
  const user = userEvent.setup();
  await user.click(toggle());
  await waitFor(() => expect(modeOf(container())).toBe("overlay"));
  const inside = container()?.querySelector<HTMLElement>("button, [tabindex]");
  if (!inside) throw new Error("nothing focusable in the peek");
  inside.focus();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(container()).toBeNull());
  await waitFor(() => expect(toggle()).toHaveFocus());
});

test("closing a sheet that stayed open across 1280px doesn't remember 'closed' for the column", async () => {
  const { viewport } = await visit(900);
  await userEvent.click(toggle());
  await waitFor(() => expect(modeOf(container())).toBe("overlay"));
  act(() => viewport.set(1440));
  // Latched: still the sheet until it closes.
  expect(modeOf(container())).toBe("overlay");
  await userEvent.click(toggle());
  await waitFor(() => expect(modeOf(container())).not.toBe("overlay"));
  expect(localStorage.getItem("of-agent-details")).not.toBe("closed");
});

test("an open sheet closes when the next agent fails to load, rather than staying empty", async () => {
  vi.unstubAllGlobals();
  mockApi({
    "GET /api/agents/dev": () => json(detail()),
    "GET /api/agents/dev/events?": () => json(conversation()),
    "GET /api/agents/lead": () => json({ error: { code: "internal", message: "Boom." } }, 500),
  });
  const app = await visit(900);
  await userEvent.click(toggle());
  await waitFor(() => expect(modeOf(container())).toBe("overlay"));
  await act(() => app.router.navigate({ to: "/agents/$slug/session", params: { slug: "lead" } }));
  await screen.findByText(/Couldn't load this session/);
  await waitFor(() => expect(container()).toBeNull());
});
