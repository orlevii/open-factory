import type { AnyEvent } from "@open-factory/shared";
import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { renderInRouter } from "@/test/render-in-router";
import { RowMenu, rowMenuItems } from "./row-menu";
import type { Row } from "./rows";
import { Timeline } from "./timeline";

const at = "2026-11-21T10:00:00.000Z";
const text = (seq: number): Row => ({
  kind: "text",
  seq,
  at,
  text: `Text **${seq}**`,
  key: `${seq}`,
  head: false,
});
const tool = (name: string, input: Record<string, unknown>): Row => ({
  kind: "tool",
  seq: 2,
  at,
  call: { type: "tool_call", toolUseId: "t2", name, input },
  state: "done",
  children: [],
  key: "2",
});
const outgoing = (to: string, result?: Record<string, unknown>): Row => ({
  kind: "outgoing",
  seq: 3,
  at,
  call: {
    type: "tool_call",
    toolUseId: "t3",
    name: "mcp__factory__send_message",
    input: { to, body: "ping **you**" },
  },
  ...(result
    ? {
        result: {
          type: "tool_result",
          toolUseId: "t3",
          content: JSON.stringify(result),
          isError: false,
        } as Extract<AnyEvent, { type: "tool_result" }>,
      }
    : {}),
  turnOpen: false,
  key: "3",
});
const footer: Row = { kind: "turn_footer", seq: 9, key: "9", durationMs: 5000, costUsd: 0 };

const labels = (row: Row) =>
  rowMenuItems(row, "dev")
    .filter((i) => i.kind !== "time")
    .map((i) => i.label);

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fakeMatchMedia.install(true);
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});
afterEach(() => vi.useRealTimers());

test("items, only those that apply: Copy text on agent text, Copy command on Bash", () => {
  expect(labels(text(1))).toEqual(["Copy link", "Copy text"]);
  expect(labels(tool("Bash", { command: "ls -la" }))).toEqual(["Copy link", "Copy command"]);
  expect(labels(tool("Read", { file_path: "/a" }))).toEqual(["Copy link"]);
  expect(labels(footer)).toEqual(["Copy link"]);
});

test("outgoing: View tool call, and Open in inbox only when it went to a human", () => {
  expect(labels(outgoing("@humans", { id: "m1", to: "@humans", status: "inbox" }))).toEqual([
    "Copy link",
    "Copy text",
    "View tool call",
    "Open in inbox",
  ]);
  expect(labels(outgoing("b", { id: "m1", to: "b", status: "idle" }))).toEqual([
    "Copy link",
    "Copy text",
    "View tool call",
    "View in @b's session",
  ]);
  // Not sent yet: nothing to view in the recipient's session.
  expect(labels(outgoing("b"))).toEqual(["Copy link", "Copy text", "View tool call"]);
});

test("the copied text is the markdown source; the link is the row's deep link", () => {
  const items = rowMenuItems(text(1), "my agent");
  expect(items[0]).toMatchObject({
    kind: "copy",
    text: `${location.origin}/agents/my%20agent?event=1`,
  });
  expect(items[1]).toMatchObject({ kind: "copy", text: "Text **1**" });
  expect(rowMenuItems(tool("Bash", { command: "ls -la" }), "dev")[1]).toMatchObject({
    text: "ls -la",
  });
});

const openMenu = async (trigger: HTMLElement) => {
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
  return screen.findByRole("menu");
};

test("a row with only Copy link still opens the menu; no disabled filler", async () => {
  renderInRouter(<RowMenu items={rowMenuItems(footer, "dev")} focusable />);
  const menu = await openMenu(await screen.findByRole("button", { name: "Row actions" }));
  const items = within(menu).getAllByRole("menuitem");
  expect(items.map((i) => i.textContent)).toEqual(["Copy link"]);
  expect(menu.querySelector("[data-disabled]")).toBeNull();
});

test("on touch the menu carries the time as a label; on a fine pointer it doesn't", async () => {
  const media = fakeMatchMedia.install(true, { coarse: true });
  const first = renderInRouter(<RowMenu items={rowMenuItems(text(1), "dev")} focusable />);
  let menu = await openMenu(await screen.findByRole("button", { name: "Row actions" }));
  expect(within(menu).getByText(/^Sent \d\d:\d\d:\d\d$/)).toBeInTheDocument();
  first.unmount();
  media.setCoarse(false);
  fakeMatchMedia.install(true, { coarse: false });
  renderInRouter(<RowMenu items={rowMenuItems(text(1), "dev")} focusable />);
  menu = await openMenu(await screen.findByRole("button", { name: "Row actions" }));
  expect(within(menu).queryByText(/^Sent /)).toBeNull();
});

test("Copy text copies the source, and the trigger shows the check", async () => {
  renderInRouter(<RowMenu items={rowMenuItems(text(1), "dev")} focusable />);
  const trigger = await screen.findByRole("button", { name: "Row actions" });
  const menu = await openMenu(trigger);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Copy text" }));
  expect(writeText).toHaveBeenCalledWith("Text **1**");
  expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
});

test("the keyboard opens the menu on the first Enter or Space, and its copy feedback is instant", async () => {
  renderInRouter(<RowMenu items={rowMenuItems(text(1), "dev")} focusable />);
  const user = userEvent.setup();
  // setup() installs its own clipboard; ours goes back on top.
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const trigger = await screen.findByRole("button", { name: "Row actions" });
  trigger.focus();
  await user.keyboard("{Enter}");
  const menu = await screen.findByRole("menu");
  // The first item takes focus on the very first keyboard opening, with no Arrow Down (WAI-ARIA).
  const link = within(menu).getByRole("menuitem", { name: "Copy link" });
  await vi.waitFor(() => expect(link).toHaveFocus());
  await user.keyboard("{Enter}");
  expect(writeText).toHaveBeenCalled();
  const copied = await screen.findByRole("button", { name: "Copied" });
  expect(copied.querySelector("[data-copy-feedback]")).toHaveAttribute("data-instant");
  // Focus is back on the trigger, and Space reopens it.
  await vi.waitFor(() => expect(copied).toHaveFocus());
  await user.keyboard(" ");
  expect(await screen.findByRole("menu")).toBeInTheDocument();
});

test("Space opens a trigger that was never activated, focused on its first item", async () => {
  renderInRouter(<RowMenu items={rowMenuItems(text(1), "dev")} focusable />);
  (await screen.findByRole("button", { name: "Row actions" })).focus();
  await userEvent.keyboard(" ");
  const menu = await screen.findByRole("menu");
  await vi.waitFor(() =>
    expect(within(menu).getByRole("menuitem", { name: "Copy link" })).toHaveFocus(),
  );
});

test("Escape returns focus to the trigger, which shows while it returns", async () => {
  renderInRouter(<RowMenu items={rowMenuItems(text(1), "dev")} focusable />);
  (await screen.findByRole("button", { name: "Row actions" })).focus();
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("menu");
  await userEvent.keyboard("{Escape}");
  const trigger = document.querySelector('[data-slot="dropdown-menu-trigger"]') as HTMLElement;
  await vi.waitFor(() => expect(trigger).toHaveFocus());
  expect(trigger).toHaveClass("data-returning:inline-flex");
  expect(trigger).not.toHaveAttribute("data-returning");
});

test("a pointer opening leaves focus on the menu, not an item", async () => {
  renderInRouter(<RowMenu items={rowMenuItems(text(1), "dev")} focusable />);
  const menu = await openMenu(await screen.findByRole("button", { name: "Row actions" }));
  await vi.waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
  expect(within(menu).getByRole("menuitem", { name: "Copy link" })).not.toHaveFocus();
});

test("while its menu is open the trigger stays shown, so the menu keeps its anchor", async () => {
  renderInRouter(<RowMenu items={rowMenuItems(text(1), "dev")} focusable />);
  await openMenu(await screen.findByRole("button", { name: "Row actions" }));
  const trigger = document.querySelector('[data-slot="dropdown-menu-trigger"]') as HTMLElement;
  expect(trigger).toHaveAttribute("data-state", "open");
  // The row's hover and focus-within are gone under a modal menu; this variant keeps it displayed.
  expect(trigger).toHaveClass("data-[state=open]:inline-flex");
});

test("a builder is called only when the menu first opens", async () => {
  const build = vi.fn(() => rowMenuItems(text(1), "dev"));
  renderInRouter(<RowMenu items={build} focusable />);
  const trigger = await screen.findByRole("button", { name: "Row actions" });
  expect(build).not.toHaveBeenCalled();
  const menu = await openMenu(trigger);
  expect(build).toHaveBeenCalledTimes(1);
  expect(within(menu).getByRole("menuitem", { name: "Copy text" })).toBeInTheDocument();
});

test("the check reverts after 1.5s", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  renderInRouter(<RowMenu items={rowMenuItems(footer, "dev")} focusable />);
  const menu = await openMenu(await screen.findByRole("button", { name: "Row actions" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy link" }));
  expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(1600));
  expect(await screen.findByRole("button", { name: "Row actions" })).toBeInTheDocument();
});

test("a refused clipboard says Couldn't copy inline", async () => {
  writeText.mockRejectedValue(new Error("denied"));
  renderInRouter(<RowMenu items={rowMenuItems(footer, "dev")} focusable />);
  const menu = await openMenu(await screen.findByRole("button", { name: "Row actions" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy link" }));
  expect(await screen.findByText("Couldn't copy")).toBeInTheDocument();
});

const many = Array.from({ length: 200 }, (_, i) => text(i + 1));
const timeline = (rows: Row[]) => (
  <Timeline
    slug="dev"
    rows={rows}
    failedIds={new Set()}
    interruptedEnds={new Set()}
    hasMoreBefore={false}
    onLoadEarlier={async () => false}
    earlierError={false}
    footer={null}
  />
);

test("200 rows mount 200 plain triggers and no menu root", async () => {
  renderInRouter(timeline(many));
  await screen.findByText("200");
  expect(document.querySelectorAll("[data-copy-link]")).toHaveLength(200);
  expect(document.querySelectorAll('[data-slot="dropdown-menu-trigger"]')).toHaveLength(0);
  expect(document.querySelectorAll('[aria-haspopup="menu"]')).toHaveLength(200);
});

test("applyTo skips the trigger: only the tab row's trigger is tabbable", async () => {
  renderInRouter(timeline([text(1), text(2), text(3)]));
  await screen.findByText("3");
  const triggers = [...document.querySelectorAll<HTMLElement>("[data-copy-link]")];
  expect(triggers.map((t) => t.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
  // Activated, the Radix trigger keeps the attribute and the row's tabindex.
  fireEvent.pointerDown(triggers[0] as HTMLElement, { button: 0, pointerType: "mouse" });
  await screen.findByRole("menu");
  const active = document.querySelector('[data-slot="dropdown-menu-trigger"]');
  expect(active).toHaveAttribute("data-copy-link");
  expect(active).toHaveAttribute("tabindex", "0");
});

test("tool rows and agent text show their time in the gutter; the footer has none", async () => {
  renderInRouter(timeline([text(1), tool("Bash", { command: "ls" }), footer]));
  await screen.findByText("ls");
  const wrapOf = (key: string) =>
    document.querySelector(`[data-row="${key}"]`)?.closest("[data-row-wrap]") as HTMLElement;
  expect(wrapOf("1").querySelector("time[data-gutter-time]")).toHaveAttribute("datetime", at);
  expect(wrapOf("2").querySelector("time[data-gutter-time]")).toHaveAttribute("datetime", at);
  expect(wrapOf("9").querySelector("time[data-gutter-time]")).toBeNull();
});

test("tool rows take the .of-row pressed fill", async () => {
  renderInRouter(timeline([tool("Bash", { command: "ls" })]));
  expect(await screen.findByRole("button", { name: /Bash/ })).toHaveClass("of-row");
});

const card = (kind: "system" | "message", seq: number): Row => ({
  kind: "message",
  seq,
  at,
  message: { id: `m${seq}`, from: "@factory", kind, urgent: false, body: `Body ${seq}` },
  key: `${seq}:0`,
});

test("cards span the column with ⋯ inside their padding; unboxed rows keep the 2rem right column", async () => {
  renderInRouter(
    timeline([
      text(1),
      outgoing("bob", { id: "m1", to: "bob", status: "delivered" }),
      card("message", 5),
      card("system", 6),
    ]),
  );
  await screen.findByText("Body 6");
  const wrapOf = (key: string) =>
    document.querySelector(`[data-row="${key}"]`)?.closest("[data-row-wrap]") as HTMLElement;
  const trigger = (key: string) => wrapOf(key).querySelector("[data-copy-link]") as HTMLElement;
  for (const key of ["3", "5:0"]) {
    expect(wrapOf(key)).not.toHaveClass("pr-8");
    expect(trigger(key)).toHaveClass("top-1.5", "right-1.5");
    // The card leaves room for the trigger inside its own padding.
    expect(wrapOf(key).querySelector(".rounded-lg")).toHaveClass("pr-9");
  }
  // Agent text and a factory notice are unboxed.
  for (const key of ["1", "6:0"]) {
    expect(wrapOf(key)).toHaveClass("pr-8");
    expect(trigger(key)).toHaveClass("top-1", "right-0");
  }
});

test("a tool row's gutter time sits in the row's own line after its state, never painted over it", async () => {
  renderInRouter(timeline([tool("Bash", { command: "ls" })]));
  const row = await screen.findByRole("button", { name: /Bash/ });
  const time = row.querySelector("time[data-gutter-time]") as HTMLElement;
  expect(time).not.toBeNull();
  expect(time).not.toHaveClass("bg-background");
  expect(time).not.toHaveClass("absolute");
  // Content | time | ⋯: the time is the line's last item, after the state when there is one.
  expect(row.lastElementChild).toBe(time);
});
