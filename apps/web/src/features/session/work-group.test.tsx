import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { groupWork } from "./display-passes";
import type { Row } from "./rows";
import { Timeline } from "./timeline";

type ToolR = Extract<Row, { kind: "tool" }>;
const at = "2026-11-19T09:00:00.000Z";
const sh = (seq: number): ToolR => ({
  kind: "tool",
  seq,
  at,
  resultAt: at,
  call: {
    type: "tool_call",
    toolUseId: `tu${seq}`,
    name: "Bash",
    input: { command: `cmd ${seq}` },
  },
  state: "done",
  children: [],
  key: `${seq}`,
});

function timeline(rows: Row[]) {
  const props = {
    slug: "dev",
    failedIds: new Set<string>(),
    interruptedEnds: new Set<number>(),
    hasMoreBefore: false,
    onLoadEarlier: async () => false,
    earlierError: false,
    footer: null,
  };
  const view = render(<Timeline {...props} rows={rows} />);
  return { ...view, update: (next: Row[]) => view.rerender(<Timeline {...props} rows={next} />) };
}
const rowEl = (key: string) => document.querySelector<HTMLElement>(`[data-row="${key}"]`);

test("a group open only through an expanded call: focusing that call makes it the tab stop", async () => {
  const user = userEvent.setup();
  const later = sh(5);
  const view = timeline([later]);
  await user.click(rowEl("5") as HTMLElement);
  // An earlier page lands: the expanded call joins a group keyed by another call.
  view.update(groupWork([sh(3), later]));
  expect(rowEl("3")).toHaveAttribute("aria-expanded", "true");
  act(() => rowEl("5")?.focus());
  expect(rowEl("5")).toHaveAttribute("tabindex", "0");
  expect(rowEl("3")).toHaveAttribute("tabindex", "-1");
});

test("closing a group clears its calls' inner keys too, so a later regrouping stays closed", async () => {
  const user = userEvent.setup();
  const [a, b, c] = [sh(3), sh(5), sh(7)];
  const view = timeline(groupWork([a, b]));
  await user.click(rowEl("3") as HTMLElement); // open the group
  await user.click(rowEl("5") as HTMLElement); // open call 5
  await user.click(rowEl("3") as HTMLElement); // close the group
  expect(rowEl("3")).toHaveAttribute("aria-expanded", "false");
  // The runs split differently: call 5 now leads a group of its own.
  view.update([
    a,
    { kind: "text", seq: 4, at, text: "t", key: "4", head: false },
    ...groupWork([b, c]),
  ]);
  expect(rowEl("5")).toHaveAttribute("aria-expanded", "false");
});

test("each call in an open group has its own row menu and gutter time (Copy command per call)", async () => {
  const user = userEvent.setup();
  timeline(groupWork([sh(3), sh(5)]));
  // Collapsed: the group's own menu only.
  expect(screen.getAllByRole("button", { name: "Row actions", hidden: true })).toHaveLength(1);
  await user.click(rowEl("3") as HTMLElement);
  const calls = [rowEl("c:3"), rowEl("5")].map((el) => el?.closest("[data-call]") as HTMLElement);
  for (const call of calls) {
    expect(within(call).getAllByRole("button", { name: "Row actions", hidden: true })).toHaveLength(
      1,
    );
    // Like a top-level tool row's, the time is in the call's own line (never over its chip), and
    // shows on that call's hover or focus only.
    const time = call.querySelector("[data-gutter-time]");
    expect(time?.closest("[data-row]")).not.toBeNull();
    expect(time).not.toHaveClass("absolute");
    expect(time).toHaveClass("group-hover/call:inline");
    expect(time).not.toHaveClass("group-hover:inline");
  }
  const trigger = within(calls[1] as HTMLElement).getByRole("button", {
    name: "Row actions",
    hidden: true,
  });
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
  const menu = await screen.findByRole("menu");
  expect(within(menu).getByRole("menuitem", { name: "Copy command" })).toBeInTheDocument();
  expect(within(menu).getByRole("menuitem", { name: "Copy link" })).toBeInTheDocument();
});

test("after a pointer click, an open that came from elsewhere turns the chevron at once", async () => {
  const user = userEvent.setup();
  const text: Row = { kind: "text", seq: 6, at, text: "t", key: "6", head: false };
  const [a, b, c] = [sh(3), sh(5), sh(7)];
  const view = timeline([...groupWork([a, b]), text, c]);
  const chevron = () => rowEl("3")?.querySelector("svg") as SVGElement;
  await user.click(rowEl("3") as HTMLElement); // pointer open: animates
  expect(chevron()).toHaveClass("transition-transform");
  await user.click(rowEl("3") as HTMLElement); // pointer close
  await user.click(rowEl("7") as HTMLElement); // expand the call standing alone
  // The text between is gone (a re-split): the expanded call joins and opens the group.
  view.update(groupWork([a, b, c]));
  expect(rowEl("3")).toHaveAttribute("aria-expanded", "true");
  expect(chevron()).not.toHaveClass("transition-transform");
});

test("Esc on a call's ⋯ inside an open group returns focus to that call", async () => {
  const user = userEvent.setup();
  timeline(groupWork([sh(3), sh(5)]));
  await user.click(rowEl("3") as HTMLElement);
  const call = rowEl("5")?.closest("[data-call]") as HTMLElement;
  const menu = within(call).getByRole("button", { name: "Row actions", hidden: true });
  act(() => menu.focus());
  await user.keyboard("{Escape}");
  expect(rowEl("5")).toHaveFocus();
});
