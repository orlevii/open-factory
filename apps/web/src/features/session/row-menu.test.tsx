import type { AnyEvent } from "@open-factory/shared";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { refFor } from "@/test/refs";
import { renderInRouter } from "@/test/render-in-router";
import { envelope } from "@/test/session-fixtures";
import { formatTime } from "./format";
import { RowMenu, type RowMenuHandle, rowMenuItems, rowMenuTitle } from "./row-menu";
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
const outgoing = (to: string | string[], result?: Record<string, unknown>): Row => ({
  kind: "outgoing",
  seq: 3,
  at,
  call: {
    type: "tool_call",
    toolUseId: "t3",
    name: "mcp__factory__send_message",
    input: { to: [to].flat(), body: "ping **you**" },
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
  // Desktop (48rem and up), fine pointer.
  fakeMatchMedia.install(false);
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

const reached = (to: string, kind: "agent" | "human", id = "m1") =>
  kind === "human"
    ? { to, kind, status: "inbox", id }
    : { to, kind, status: "queued", recipient_status: "idle", id };

const messageFrom = (from: string, fromKind: "human" | "agent"): Row => ({
  kind: "message",
  seq: 4,
  at,
  message: envelope({ id: "m4", from, fromKind, kind: "message", urgent: false, body: "hi" }),
  key: "4",
});

test("Open in chat: on your own messages with this agent, and on a send to you", () => {
  // Stored envelopes and send results write principals as tags; your ref is what says "you".
  const OR = "<@k7x2m9qd|or>";
  const SAM = "<@p3dh8vcn|sam>";
  const chat = (row: Row, selfRef?: string) =>
    rowMenuItems(row, "dev", selfRef).filter((i) => i.kind === "chat");
  expect(chat(messageFrom(OR, "human"), "k7x2m9qd")).toEqual([
    { kind: "chat", label: "Open in chat", agentRef: "dev", messageId: "m4" },
  ]);
  // The ref counts, whatever label the envelope carried when it was written.
  expect(chat(messageFrom("<@k7x2m9qd|old-name>", "human"), "k7x2m9qd")).toHaveLength(1);
  // Someone else's message, or no known ref: it isn't in your chat.
  expect(chat(messageFrom(SAM, "human"), "k7x2m9qd")).toEqual([]);
  expect(chat(messageFrom(OR, "human"))).toEqual([]);
  expect(chat(messageFrom("<@dev00000|lead>", "agent"), "k7x2m9qd")).toEqual([]);
  expect(chat(outgoing("@or", { results: [reached(OR, "human", "m5")] }), "k7x2m9qd")).toEqual([
    { kind: "chat", label: "Open in chat", agentRef: "dev", messageId: "m5" },
  ]);
  expect(chat(outgoing("@sam", { results: [reached(SAM, "human")] }), "k7x2m9qd")).toEqual([]);
});

test("the drawer title names a tagged sender and a tagged report by their handle", () => {
  expect(rowMenuTitle(messageFrom("<@k7x2m9qd|or>", "human"), "dev")).toMatch(
    /^Message from @or · /,
  );
  const group: Row = {
    kind: "update_group",
    seq: 5,
    at,
    about: "<@dev00000|dev>",
    envelopes: [],
    key: "5",
  };
  expect(rowMenuTitle(group, "lead")).toMatch(/^Updates about @dev · /);
});

test("outgoing: View tool call, and Open in inbox only when it went to a human", () => {
  expect(labels(outgoing("@or", { results: [reached("@or", "human")] }))).toEqual([
    "Copy link",
    "Copy text",
    "View tool call",
    "Open in inbox",
  ]);
  expect(labels(outgoing("@b", { results: [reached("<@b0b00001|b>", "agent")] }))).toEqual([
    "Copy link",
    "Copy text",
    "View tool call",
    "View in @b's session",
  ]);
  // Not sent yet: nothing to view in the recipient's session.
  expect(labels(outgoing("@b"))).toEqual(["Copy link", "Copy text", "View tool call"]);
});

test("a send to several people lists everyone in a Recipients item and links to none", () => {
  const to = ["@a", "@b", "@c", "@d"];
  const row = outgoing(to, { results: to.map((t) => reached(t, "agent", t)) });
  expect(labels(row)).toEqual(["Copy link", "Copy text", "View tool call", "Recipients"]);
  expect(rowMenuItems(row, "dev").find((i) => i.kind === "recipients")).toMatchObject({
    text: "@a, @b, @c, @d",
  });
  expect(rowMenuTitle(row, "dev")).toMatch(/^Message to @a, @b \+2 · /);
});

test("the copied text is the markdown source; the link is the row's deep link", () => {
  const items = rowMenuItems(text(1), "my agent");
  expect(items[0]).toMatchObject({
    kind: "copy",
    text: `${location.origin}/agents/my%20agent/session?event=1`,
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
  renderInRouter(<RowMenu items={rowMenuItems(footer, "dev")} title="@dev" focusable />);
  const menu = await openMenu(await screen.findByRole("button", { name: "Row actions" }));
  const items = within(menu).getAllByRole("menuitem");
  expect(items.map((i) => i.textContent)).toEqual(["Copy link"]);
  expect(menu.querySelector("[data-disabled]")).toBeNull();
});

test("on touch the menu carries the time as a label; on a fine pointer it doesn't", async () => {
  // A tablet: touch, but wide enough for the dropdown.
  const media = fakeMatchMedia.install(false, { coarse: true });
  const first = renderInRouter(
    <RowMenu items={rowMenuItems(text(1), "dev")} title="@dev" focusable />,
  );
  let menu = await openMenu(await screen.findByRole("button", { name: "Row actions" }));
  expect(within(menu).getByText(/^Sent \d\d:\d\d:\d\d$/)).toBeInTheDocument();
  first.unmount();
  media.setCoarse(false);
  fakeMatchMedia.install(false, { coarse: false });
  renderInRouter(<RowMenu items={rowMenuItems(text(1), "dev")} title="@dev" focusable />);
  menu = await openMenu(await screen.findByRole("button", { name: "Row actions" }));
  expect(within(menu).queryByText(/^Sent /)).toBeNull();
});

test("Copy text copies the source, and the trigger shows the check", async () => {
  renderInRouter(<RowMenu items={rowMenuItems(text(1), "dev")} title="@dev" focusable />);
  const trigger = await screen.findByRole("button", { name: "Row actions" });
  const menu = await openMenu(trigger);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Copy text" }));
  expect(writeText).toHaveBeenCalledWith("Text **1**");
  expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
});

test("the keyboard opens the menu on the first Enter or Space, and its copy feedback is instant", async () => {
  renderInRouter(<RowMenu items={rowMenuItems(text(1), "dev")} title="@dev" focusable />);
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
  renderInRouter(<RowMenu items={rowMenuItems(text(1), "dev")} title="@dev" focusable />);
  (await screen.findByRole("button", { name: "Row actions" })).focus();
  await userEvent.keyboard(" ");
  const menu = await screen.findByRole("menu");
  await vi.waitFor(() =>
    expect(within(menu).getByRole("menuitem", { name: "Copy link" })).toHaveFocus(),
  );
});

test("Escape returns focus to the trigger", async () => {
  renderInRouter(<RowMenu items={rowMenuItems(text(1), "dev")} title="@dev" focusable />);
  (await screen.findByRole("button", { name: "Row actions" })).focus();
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("menu");
  await userEvent.keyboard("{Escape}");
  const trigger = document.querySelector('[data-slot="dropdown-menu-trigger"]') as HTMLElement;
  await vi.waitFor(() => expect(trigger).toHaveFocus());
  expect(trigger).not.toHaveAttribute("data-returning");
});

test("a pointer opening leaves focus on the menu, not an item", async () => {
  renderInRouter(<RowMenu items={rowMenuItems(text(1), "dev")} title="@dev" focusable />);
  const menu = await openMenu(await screen.findByRole("button", { name: "Row actions" }));
  await vi.waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
  expect(within(menu).getByRole("menuitem", { name: "Copy link" })).not.toHaveFocus();
});

test("a builder is called only when the menu first opens", async () => {
  const build = vi.fn(() => rowMenuItems(text(1), "dev"));
  renderInRouter(<RowMenu items={build} title="@dev" focusable />);
  const trigger = await screen.findByRole("button", { name: "Row actions" });
  expect(build).not.toHaveBeenCalled();
  const menu = await openMenu(trigger);
  expect(build).toHaveBeenCalledTimes(1);
  expect(within(menu).getByRole("menuitem", { name: "Copy text" })).toBeInTheDocument();
});

test("the check reverts after 1.5s", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  renderInRouter(<RowMenu items={rowMenuItems(footer, "dev")} title="@dev" focusable />);
  const menu = await openMenu(await screen.findByRole("button", { name: "Row actions" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy link" }));
  expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(1600));
  expect(await screen.findByRole("button", { name: "Row actions" })).toBeInTheDocument();
});

test("a refused clipboard says Couldn't copy inline", async () => {
  writeText.mockRejectedValue(new Error("denied"));
  renderInRouter(<RowMenu items={rowMenuItems(footer, "dev")} title="@dev" focusable />);
  const menu = await openMenu(await screen.findByRole("button", { name: "Row actions" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy link" }));
  expect(await screen.findByText("Couldn't copy")).toBeInTheDocument();
});

const timeline = (rows: Row[]) => (
  <Timeline
    agentRef={refFor("dev")}
    rows={rows}
    failedIds={new Set()}
    interruptedEnds={new Set()}
    hasMoreBefore={false}
    onLoadEarlier={async () => false}
    earlierError={false}
    footer={null}
  />
);

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
  await screen.findByText("$ ls");
  const wrapOf = (key: string) =>
    document.querySelector(`[data-row="${key}"]`)?.closest("[data-row-wrap]") as HTMLElement;
  expect(wrapOf("1").querySelector("time[data-gutter-time]")).toHaveAttribute("datetime", at);
  expect(wrapOf("2").querySelector("time[data-gutter-time]")).toHaveAttribute("datetime", at);
  expect(wrapOf("9").querySelector("time[data-gutter-time]")).toBeNull();
});

test("a tool row's gutter time sits in the row's own line after its state", async () => {
  renderInRouter(timeline([tool("Bash", { command: "ls" })]));
  // The Bash renderer's summary is the command (`$ ls`), not the tool's name.
  const row = await screen.findByRole("button", { name: /\$ ls/ });
  const time = row.querySelector("time[data-gutter-time]") as HTMLElement;
  expect(time).not.toBeNull();
  // Not part of the row's accessible name: the title and, on touch, the menu carry the time.
  expect(time).toHaveAttribute("aria-hidden", "true");
  // Content | time | ⋯: the time is the line's last item, after the state when there is one.
  expect(row.lastElementChild).toBe(time);
});

const message: Row = {
  kind: "message",
  seq: 4,
  at,
  message: envelope({
    id: "m4",
    from: "@or",
    fromKind: "human",
    kind: "message",
    urgent: false,
    body: "Hi",
  }),
  key: "4:0",
};

test("the menu's title names the row: who a message is from, the tool, with the time", () => {
  const t = formatTime(at);
  expect(rowMenuTitle(message, "dev")).toBe(`Message from @or · ${t}`);
  expect(rowMenuTitle(tool("Bash", { command: "ls" }), "dev")).toBe(`Bash · ${t}`);
  expect(rowMenuTitle(text(1), "dev")).toBe(`@dev · ${t}`);
  expect(rowMenuTitle(outgoing("@bob"), "dev")).toBe(`Message to @bob · ${t}`);
  expect(rowMenuTitle(footer, "dev")).toBe("Turn summary");
  const peer = (left?: { reason: "archived" }): Row => ({
    kind: "peer",
    seq: 8,
    key: "8:0",
    envelope: envelope({
      id: "e8",
      from: "@factory",
      fromKind: "factory",
      kind: left ? "peer_left" : "peer_joined",
      urgent: false,
      body: "",
      subject: { handle: "bob", displayName: "Bob", relation: "peer", left },
    }),
  });
  expect(rowMenuTitle(peer(), "dev")).toBe("@bob joined");
  expect(rowMenuTitle(peer({ reason: "archived" }), "dev")).toBe("@bob left");
});

const touchDown = (el: Element) => fireEvent.pointerDown(el, { button: 0, pointerType: "touch" });

test("a touch pointerdown on ⋯ opens nothing: a scroll may be starting there", async () => {
  renderInRouter(<RowMenu items={rowMenuItems(text(1), "dev")} title="@dev" focusable />);
  const trigger = await screen.findByRole("button", { name: "Row actions" });
  touchDown(trigger);
  fireEvent.pointerCancel(trigger, { pointerType: "touch" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  // The tap's click opens it (on a tablet, the dropdown).
  touchDown(trigger);
  fireEvent.click(trigger);
  expect(await screen.findByRole("menu")).toBeInTheDocument();
});

test("on a phone the ⋯ opens a drawer titled for the row", async () => {
  fakeMatchMedia.install(true, { coarse: true });
  const build = vi.fn(() => rowMenuTitle(message, "dev"));
  renderInRouter(<RowMenu items={rowMenuItems(message, "dev")} title={build} focusable />);
  const trigger = await screen.findByRole("button", { name: "Row actions" });
  expect(build).not.toHaveBeenCalled();
  touchDown(trigger);
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(trigger);
  const drawer = await screen.findByRole("dialog", {
    name: `Message from @or · ${formatTime(at)}`,
  });
  await userEvent.click(within(drawer).getByRole("button", { name: "Copy text" }));
  expect(writeText).toHaveBeenCalledWith("Hi");
});

test("openAt opens the menu hanging from the point, and the ⋯ reopens it from itself", async () => {
  const ref = createRef<RowMenuHandle>();
  renderInRouter(<RowMenu ref={ref} items={rowMenuItems(text(1), "dev")} title="@dev" focusable />);
  await screen.findByRole("button", { name: "Row actions" });
  act(() => ref.current?.openAt({ x: 40, y: 120 }));
  const menu = await screen.findByRole("menu", { name: "@dev" });
  expect(within(menu).getByRole("menuitem", { name: "Copy text" })).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await openMenu(screen.getByRole("button", { name: "Row actions" }));
  expect(document.querySelector("[data-menu-stand-in]")).toBeNull();
});

test("the handle is stable across renders", async () => {
  const ref = createRef<RowMenuHandle>();
  const items = rowMenuItems(text(1), "dev");
  const { rerender } = render(<RowMenu ref={ref} items={items} title="@dev" focusable />);
  const first = ref.current;
  rerender(<RowMenu ref={ref} items={items} title="@dev" focusable={false} />);
  expect(ref.current).toBe(first);
});
