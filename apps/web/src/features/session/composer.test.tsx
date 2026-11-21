import type { AgentSummary } from "@open-factory/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { agentSummary } from "@/test/session-fixtures";
import { Composer } from "./composer";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
let posted: { url: string; body: unknown }[];
let reply: (url: string) => Response | Promise<Response>;
beforeEach(() => {
  sessionStorage.clear();
  posted = [];
  reply = (url) =>
    url.endsWith("/interrupt")
      ? json({}, 202)
      : json({ item: { id: "q", kind: "message", from: "@alice", createdAt: "x" } }, 202);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      posted.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      return reply(url);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const working = (over: Partial<AgentSummary> = {}) =>
  agentSummary({ status: "working", turnOpen: true, ...over });

/** The composer as the session renders it, with its agent and turn epoch changeable from the test. */
function setup(initial: AgentSummary, extra?: ReactNode) {
  const ui = (agent: AgentSummary, epoch: number) => (
    <>
      {extra}
      <Composer slug="dev" agent={agent} turnEpoch={epoch} />
    </>
  );
  const r = render(ui(initial, 1));
  return {
    box: screen.getByRole("textbox", { name: "Message to Dev agent" }),
    update: (a: AgentSummary, epoch: number) => r.rerender(ui(a, epoch)),
  };
}

/** A non-modal popover standing in for a peek: open, with focus left in the composer. */
function Peek() {
  const [open, setOpen] = useState(true);
  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverAnchor />
      <PopoverContent onOpenAutoFocus={(e) => e.preventDefault()}>Peek body</PopoverContent>
    </Popover>
  );
}
const interrupts = () => posted.filter((p) => p.url.endsWith("/interrupt"));
const tick = () => act(() => new Promise((r) => setTimeout(r, 10)));

test("Esc in the composer stops an open turn once; does nothing with no turn", async () => {
  const { box, update } = setup(working());
  box.focus();
  fireEvent.keyDown(box, { key: "Escape" });
  fireEvent.keyDown(box, { key: "Escape" }); // Stop is pending: no second interrupt
  await tick();
  expect(interrupts()).toEqual([{ url: "/api/agents/dev/interrupt", body: {} }]);
  update(agentSummary(), 2);
  fireEvent.keyDown(box, { key: "Escape" });
  await tick();
  expect(interrupts()).toHaveLength(1);
});

test("Esc that stops is handled; Esc that doesn't is left to others", async () => {
  const { box, update } = setup(working());
  const outer = vi.fn();
  document.addEventListener("keydown", outer);
  try {
    fireEvent.keyDown(box, { key: "Escape" });
    expect(outer).not.toHaveBeenCalled();
    update(agentSummary(), 2);
    fireEvent.keyDown(box, { key: "Escape" });
    expect(outer).toHaveBeenCalledTimes(1);
  } finally {
    document.removeEventListener("keydown", outer);
  }
});

test("Esc during IME composition does nothing", async () => {
  const { box } = setup(working());
  fireEvent.keyDown(box, { key: "Escape", isComposing: true });
  fireEvent.keyDown(box, { key: "Escape", keyCode: 229 });
  await tick();
  expect(interrupts()).toEqual([]);
});

test("Esc with an open peek lets the peek close and doesn't stop", async () => {
  const { box } = setup(working(), <Peek />);
  box.focus();
  expect(screen.getByText("Peek body")).toBeInTheDocument();
  fireEvent.keyDown(box, { key: "Escape" });
  await tick();
  expect(screen.queryByText("Peek body")).toBeNull();
  expect(interrupts()).toEqual([]);
  fireEvent.keyDown(box, { key: "Escape" }); // nothing open now: this one stops
  await tick();
  expect(interrupts()).toHaveLength(1);
});

test("while compacting Stop is disabled and reads Compacting…", async () => {
  const { box } = setup(working({ compacting: true }));
  const stop = screen.getByRole("button", { name: "Compacting…" });
  expect(stop).toHaveAttribute("aria-disabled", "true");
  await userEvent.click(stop);
  fireEvent.keyDown(box, { key: "Escape" });
  await tick();
  expect(interrupts()).toEqual([]);
});

test("⌥Enter posts urgent:true; Enter and ⌘Enter post urgent:false", async () => {
  const { box } = setup(working());
  const sends = () => posted.filter((p) => p.url.endsWith("/messages")).map((p) => p.body);
  await userEvent.type(box, "a");
  fireEvent.keyDown(box, { key: "Enter", altKey: true });
  await vi.waitFor(() => expect(sends()).toEqual([{ body: "a", urgent: true }]));
  await vi.waitFor(() => expect(box).toHaveValue(""));
  await userEvent.type(box, "b{Enter}");
  await vi.waitFor(() => expect(sends()).toHaveLength(2));
  await vi.waitFor(() => expect(box).toHaveValue(""));
  await userEvent.type(box, "c");
  fireEvent.keyDown(box, { key: "Enter", metaKey: true });
  await vi.waitFor(() =>
    expect(sends()).toEqual([
      { body: "a", urgent: true },
      { body: "b", urgent: false },
      { body: "c", urgent: false },
    ]),
  );
  expect(screen.queryByRole("checkbox", { name: "Urgent" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Send urgent" })).toBeNull();
});

test("⌥Enter during IME composition does not send", async () => {
  const { box } = setup(working());
  await userEvent.type(box, "日本");
  fireEvent.keyDown(box, { key: "Enter", altKey: true, isComposing: true });
  fireEvent.keyDown(box, { key: "Enter", altKey: true, keyCode: 229 });
  await tick();
  expect(posted).toEqual([]);
});

test("the hint shows only while a turn is open; the composer height is unchanged", () => {
  const { update } = setup(working());
  const hint = document.querySelector("[data-composer-hint]");
  expect(hint).toHaveTextContent(
    /^Arrives at the agent's next step\. (⌥|Alt)↵ to interrupt instead\.$/,
  );
  // The line's height is reserved whether or not it has text, so the composer never resizes.
  expect(hint).toHaveClass("min-h-5");
  update(agentSummary(), 2);
  const after = document.querySelector("[data-composer-hint]");
  expect(after).toBe(hint);
  expect(after).toBeEmptyDOMElement();
  expect(after).toHaveClass("min-h-5");
});

test("on a coarse pointer the hint says to Stop first", () => {
  const real = window.matchMedia;
  window.matchMedia = ((q: string) => ({
    ...real(q),
    matches: q === "(pointer: coarse)",
  })) as typeof window.matchMedia;
  try {
    setup(working());
    expect(document.querySelector("[data-composer-hint]")).toHaveTextContent(
      "Arrives at the agent's next step. Stop first to interrupt.",
    );
  } finally {
    window.matchMedia = real;
  }
});

test("Stop is outline, left of Send; shows a spinner and Stopping… until turnEpoch changes", async () => {
  const { update } = setup(working());
  const stop = screen.getByRole("button", { name: "Stop" });
  const send = screen.getByRole("button", { name: "Send" });
  expect(stop).toHaveAttribute("data-variant", "outline");
  expect(stop.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(stop.querySelector(".lucide-circle-stop")).not.toBeNull();
  await userEvent.click(stop);
  const stopping = screen.getByRole("button", { name: "Stopping…" });
  expect(stopping).toBe(stop);
  expect(stopping).toHaveAttribute("aria-disabled", "true");
  expect(stopping.querySelector(".lucide-circle-stop")).toBeNull();
  expect(stopping.querySelector("svg.motion-safe\\:animate-spin")).not.toBeNull();
  await userEvent.click(stopping);
  expect(interrupts()).toHaveLength(1);
  // The turn closed and a new one opened in one commit: the epoch still resets Stop.
  update(working(), 3);
  expect(screen.getByRole("button", { name: "Stop" })).toHaveAttribute("aria-disabled", "false");
});

test("no Stop while no turn is open", () => {
  setup(agentSummary());
  expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
});

test("a 409 from Stop is ignored; other failures go to the composer's error line", async () => {
  reply = () => json({ error: { code: "no_open_turn", message: "No turn is open" } }, 409);
  setup(working());
  await userEvent.click(screen.getByRole("button", { name: "Stop" }));
  await tick();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Stopping…" })).toBeInTheDocument();
});

test("a failed Stop says why and allows a retry", async () => {
  reply = () => json({ error: { code: "internal", message: "Boom" } }, 500);
  setup(working());
  await userEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't stop: Boom");
  expect(screen.getByRole("button", { name: "Stop" })).toHaveAttribute("aria-disabled", "false");
});

test("Stop's label hides below a narrow composer, keeping its name", () => {
  setup(working());
  const label = screen.getByText("Stop");
  expect(label).toHaveClass("@max-[24rem]:sr-only");
  expect(label.closest(".\\@container")).not.toBeNull();
});

test("focus moves to the textarea when Stop unmounts while focused", async () => {
  const { box, update } = setup(working());
  screen.getByRole("button", { name: "Stop" }).focus();
  update(agentSummary(), 2);
  expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
  await vi.waitFor(() => expect(box).toHaveFocus());
});

test("a turn closing doesn't move focus that wasn't on Stop", async () => {
  const outside = document.createElement("button");
  document.body.append(outside);
  try {
    const { update } = setup(working());
    outside.focus();
    update(agentSummary(), 2);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(outside).toHaveFocus();
  } finally {
    outside.remove();
  }
});
