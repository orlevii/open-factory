import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { closeSheet } from "@/features/sheets/sheet-store";
import { useShortcut } from "@/lib/shortcuts";
import type { WsOptions } from "@/lib/ws";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: (_opts: WsOptions) => ({ close() {}, status: () => "connecting", send: () => true }),
}));

beforeEach(() => {
  localStorage.clear();
  fakeMatchMedia.install(false);
  mockApi({
    "GET /api/agents?ended=exclude": () => json({ agents: [], running: { count: 0, max: 8 } }),
    "GET /api/agents?ended=only": () =>
      json({ agents: [], more: false, running: { count: 0, max: 8 } }),
  });
});
afterEach(() => {
  vi.useRealTimers();
  act(() => closeSheet());
});

async function shell() {
  const r = renderApp("/inbox", alice);
  await screen.findByRole("heading", { level: 1, name: "Inbox" });
  return r;
}
const press = (key: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(document.body, { key, ...init });
function Probe({ on }: { on: () => void }) {
  useShortcut("x", on);
  return null;
}
const sheet = () => screen.queryByRole("dialog", { name: "Keyboard shortcuts" });

test.each([
  ["i", "/inbox"],
  ["t", "/tasks"],
  ["k", "/skills"],
  ["s", "/schedules"],
  ["u", "/usage"],
  ["a", "/agents"],
])("g %s goes to %s", async (k, path) => {
  const { router } = await shell();
  if (path === "/inbox") {
    press("g");
    press("u");
    await waitFor(() => expect(router.state.location.pathname).toBe("/usage"));
  }
  press("g");
  press(k);
  await waitFor(() => expect(router.state.location.pathname).toBe(path));
});

test("c opens the New task sheet over the current page", async () => {
  const { router } = await shell();
  press("c");
  expect(await screen.findByRole("dialog", { name: "New task" })).toBeInTheDocument();
  expect(router.state.location.pathname).toBe("/inbox");
});

test("the palette's New task action opens the same sheet as c", async () => {
  const { router } = await shell();
  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  const dialog = await screen.findByRole("dialog", { name: "Search" });
  await userEvent.click(within(dialog).getByRole("option", { name: "New task" }));
  expect(await screen.findByRole("dialog", { name: "New task" })).toBeInTheDocument();
  expect(router.state.location.pathname).toBe("/inbox");
});

test("? (typed with Shift) opens a non-modal Keyboard shortcuts sheet with Global, Lists and Session groups", async () => {
  await shell();
  press("?", { shiftKey: true });
  const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
  expect(dialog).toHaveAttribute("data-modal", "false");
  expect(within(dialog).getByText("Global")).toBeInTheDocument();
  expect(within(dialog).getByText("Session")).toBeInTheDocument();
  expect(within(dialog).getByText("Lists")).toBeInTheDocument();
  expect(within(dialog).getByText("j")).toBeInTheDocument();
  // Non-modal: a single-key binding is still live behind it.
  const fired = vi.fn();
  render(<Probe on={fired} />);
  press("x");
  expect(fired).toHaveBeenCalledTimes(1);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(sheet()).toBeNull());
});

test("the palette's Keyboard shortcuts action opens the sheet", async () => {
  await shell();
  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  const dialog = await screen.findByRole("dialog", { name: "Search" });
  await userEvent.click(within(dialog).getByRole("option", { name: "Keyboard shortcuts" }));
  await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull());
});

test("the Single-key shortcuts switch turns them off, persists, and the sheet stays reachable from the palette", async () => {
  const { router } = await shell();
  press("?", { shiftKey: true });
  const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
  const sw = within(dialog).getByRole("switch", { name: "Single-key shortcuts" });
  expect(sw).toBeChecked();
  await userEvent.click(sw);
  expect(sw).not.toBeChecked();
  expect(localStorage.getItem("of-single-keys")).toBe("off");
  press("c");
  expect(router.state.location.pathname).toBe("/inbox");
  // With the switch off, ? and g sequences do nothing either, and the palette still opens the sheet.
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(sheet()).toBeNull());
  press("?", { shiftKey: true });
  press("g");
  press("t");
  act(() => {});
  expect(sheet()).toBeNull();
  expect(router.state.location.pathname).toBe("/inbox");
  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  const palette = await screen.findByRole("dialog", { name: "Search" });
  await userEvent.click(within(palette).getByRole("option", { name: "Keyboard shortcuts" }));
  const reopened = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
  const sw2 = within(reopened).getByRole("switch", { name: "Single-key shortcuts" });
  expect(sw2).not.toBeChecked();
  await userEvent.click(sw2);
  expect(sw2).toBeChecked();
  press("c");
  expect(await screen.findByRole("dialog", { name: "New task" })).toBeInTheDocument();
  expect(router.state.location.pathname).toBe("/inbox");
});

test("none of them fire while typing in an input", async () => {
  const { router } = await shell();
  const input = document.createElement("input");
  document.body.append(input);
  try {
    input.focus();
    for (const k of ["c", "?"]) fireEvent.keyDown(input, { key: k });
    fireEvent.keyDown(input, { key: "g" });
    fireEvent.keyDown(input, { key: "t" });
    act(() => {});
    expect(router.state.location.pathname).toBe("/inbox");
    expect(sheet()).toBeNull();
  } finally {
    input.remove();
  }
});

test("below 768 the sheet is a modal drawer: ? still closes it, other keys stay blocked behind it", async () => {
  fakeMatchMedia.installWidth(390);
  const { router } = await shell();
  try {
    press("?", { shiftKey: true });
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="drawer-content"][data-state="open"]'),
      ).not.toBeNull(),
    );
    press("c");
    act(() => {});
    expect(router.state.location.pathname).toBe("/inbox");
    press("?", { shiftKey: true });
    await waitFor(() =>
      expect(document.querySelector('[data-slot="drawer-content"][data-state="open"]')).toBeNull(),
    );
    // Closed again, ? reopens it.
    press("?", { shiftKey: true });
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="drawer-content"][data-state="open"]'),
      ).not.toBeNull(),
    );
  } finally {
    document.body.style.pointerEvents = "";
  }
});

test("? does not toggle the sheet behind another modal", async () => {
  await shell();
  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  await screen.findByRole("dialog", { name: "Search" });
  press("?", { shiftKey: true });
  act(() => {});
  expect(sheet()).toBeNull();
});
