import type { ServerMessage } from "@open-factory/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
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

async function visit(width: number, path = "/agents/dev") {
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

test("the overlay sits below the header: Stop and the toggle stay clickable", async () => {
  vi.unstubAllGlobals();
  mockApi({
    "GET /api/agents/dev": () => json(detail({ status: "working", turnOpen: true })),
    "GET /api/agents/dev/events?": () => json(conversation()),
  });
  await visit(900);
  await userEvent.click(toggle());
  await waitFor(() => expect(modeOf(container())).toBe("overlay"));
  const sheet = container() as HTMLElement;
  expect(sheet).toHaveClass("top-12");
  expect(sheet).not.toHaveAttribute("aria-modal");
  // Still in the accessibility tree (a modal would hide the page behind).
  expect(screen.getByRole("button", { name: /Interrupt/ })).toBeInTheDocument();
  await userEvent.click(toggle());
  await waitFor(() => expect(container()).toBeNull());
});

test("switching agents keeps an open panel open (≥1024) and retargets the overlay in place", async () => {
  const wide = await visit(1100);
  await userEvent.click(toggle());
  await act(() => wide.router.navigate({ to: "/agents/$slug", params: { slug: "lead" } }));
  await screen.findByRole("heading", { level: 1, name: "Lead agent" });
  await waitFor(() => expect(within(container() as HTMLElement).getByText("@lead")).toBeTruthy());
  expect(modeOf(container())).toBe("inflow");
  wide.unmount();

  const mid = await visit(900);
  await userEvent.click(toggle());
  await waitFor(() => expect(modeOf(container())).toBe("overlay"));
  const sheet = container();
  await act(() => mid.router.navigate({ to: "/agents/$slug", params: { slug: "lead" } }));
  await screen.findByRole("heading", { level: 1, name: "Lead agent" });
  await waitFor(() => expect(within(container() as HTMLElement).getByText("@lead")).toBeTruthy());
  // The same sheet node: its content swapped in place, it never closed and reopened.
  expect(container()).toBe(sheet);
});
