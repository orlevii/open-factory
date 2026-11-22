import { act, render } from "@testing-library/react";
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
