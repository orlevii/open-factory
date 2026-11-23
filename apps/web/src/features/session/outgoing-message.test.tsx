import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { renderInRouter } from "@/test/render-in-router";
import { OutgoingMessage } from "./outgoing-message";
import { rowMenuItems } from "./row-menu";
import type { Row } from "./rows";
import { buildSpeakerIndex, SpeakerContext } from "./speaker-line";

const AT = "2026-11-23T10:00:00.000Z";
const index = buildSpeakerIndex({
  sessionAgent: { slug: "ada", displayName: "Ada", template: "dev", avatarVersion: null },
  live: [{ slug: "x", displayName: "X", template: "dev", kind: "persistent", avatarVersion: null }],
  ended: [],
  users: [],
});

type OutgoingRow = Extract<Row, { kind: "outgoing" }>;
const row = (to: string[], results?: unknown, extra: Partial<OutgoingRow> = {}): OutgoingRow => ({
  kind: "outgoing",
  seq: 1,
  at: AT,
  call: {
    type: "tool_call",
    toolUseId: "t1",
    name: "mcp__factory__send_message",
    input: { to, body: "hello all" },
  },
  ...(results === undefined
    ? {}
    : {
        result: {
          type: "tool_result",
          toolUseId: "t1",
          content: JSON.stringify({ results }),
          isError: false,
        },
      }),
  turnOpen: false,
  key: "1",
  ...extra,
});

async function show(r: OutgoingRow) {
  renderInRouter(
    <TooltipProvider>
      <SpeakerContext value={index}>
        <OutgoingMessage
          slug="ada"
          row={r}
          showCall={false}
          onToggleCall={() => {}}
          rowProps={{}}
        />
      </SpeakerContext>
    </TooltipProvider>,
  );
  await screen.findByRole("article");
}

const ten = Array.from({ length: 10 }, (_, i) => `@${"abcdefghij"[i]}`);

test("a send to ten people reads 'Ada → @a, @b +8'; the full list is the line's name and the menu's Recipients item", async () => {
  const results = ten.map((to) => ({
    to,
    kind: "agent",
    status: "queued",
    recipient_status: "idle",
    id: `m${to}`,
  }));
  const r = row(ten, results);
  await show(r);
  const line = document.querySelector("[data-speaker-line]") as HTMLElement;
  expect(line).toHaveTextContent(/^Ada.*@ada.*@a, @b \+8/);
  expect(line).toHaveAccessibleName(`To ${ten.join(", ")}`);
  expect(rowMenuItems(r, "ada").find((i) => i.kind === "recipients")).toMatchObject({
    label: "Recipients",
    text: ten.join(", "),
  });
  // Plain deliveries say nothing more.
  expect(screen.getByRole("article").textContent).not.toMatch(/Not sent|Sent ·|Sending/);
});

test("a refused and a pending recipient each get one muted line", async () => {
  await show(
    row(
      ["@x", "@y", "@ok"],
      [
        { to: "@x", status: "refused", reason: "terminated", code: "terminated" },
        {
          to: "@y",
          kind: "agent",
          status: "pending",
          id: "m2",
          note: "@y is errored; delivered on restart.",
        },
        { to: "@ok", kind: "human", status: "inbox", id: "m3" },
      ],
    ),
  );
  const card = screen.getByRole("article");
  expect(within(card).getByText("Not sent to @x: terminated")).toBeInTheDocument();
  expect(within(card).getByText("@y is errored; delivered on restart.")).toBeInTheDocument();
  expect(card.textContent).not.toContain("@ok was");
});

test("a call without a result renders from its arguments: recipients, and Sending while the turn is open", async () => {
  await show(row(["@x", "@zed"], undefined, { turnOpen: true }));
  const card = screen.getByRole("article", { name: "Message from @ada to @x, @zed" });
  expect(card).toHaveTextContent("Sending…");
  expect(within(card).getByRole("group", { name: "To @x, @zed" })).toBeInTheDocument();
});

test("one recipient keeps the 'Name → Recipient' line, with its kind from the result", async () => {
  await show(row(["@zed"], [{ to: "@zed", kind: "human", status: "inbox", id: "m1" }]));
  const line = document.querySelector("[data-speaker-line]") as HTMLElement;
  expect(line).toHaveTextContent("@zed");
  expect(within(line).queryByRole("link")).toBeNull();
});

test("a pending recipient without a note still gets its line", async () => {
  await show(row(["@y"], [{ to: "@y", kind: "agent", status: "pending", id: "m2" }]));
  expect(screen.getByRole("article")).toHaveTextContent("Not delivered yet to @y");
});

test("a result element the schema doesn't know drops only itself", async () => {
  await show(
    row(
      ["@x", "@y"],
      [
        { to: "@x", status: "refused", reason: "terminated", code: "terminated" },
        { to: "@y", surprise: true },
      ],
    ),
  );
  expect(screen.getByRole("article")).toHaveTextContent("Not sent to @x: terminated");
});

test("a note replaces the status text for that recipient", async () => {
  await show(
    row(
      ["@y"],
      [
        {
          to: "@y",
          kind: "agent",
          status: "queued",
          recipient_status: "hibernated",
          id: "m1",
          note: "Wakes @y.",
        },
      ],
    ),
  );
  const card = screen.getByRole("article");
  expect(card).toHaveTextContent("Wakes @y.");
  expect(card.textContent).not.toContain("was hibernated");
});

test("a status without a note says so for an agent", async () => {
  await show(
    row(
      ["@y"],
      [{ to: "@y", kind: "agent", status: "queued", recipient_status: "hibernated", id: "m1" }],
    ),
  );
  expect(screen.getByRole("article")).toHaveTextContent("Sent · @y was hibernated");
});

test("no result and no open turn says Not sent", async () => {
  await show(row(["@x"], undefined, { turnOpen: false }));
  expect(screen.getByRole("article")).toHaveTextContent("Not sent");
});

test("a failed call shows the tool's sentence, not per-recipient lines", async () => {
  await show(
    row(["@x"], undefined, {
      result: {
        type: "tool_result",
        toolUseId: "t1",
        content: "No one to send to.",
        isError: true,
      },
    }),
  );
  expect(screen.getByRole("article")).toHaveTextContent("No one to send to.");
});

test("the result's kind is matched to the argument whatever its case", async () => {
  await show(row(["@Ada2"], [{ to: "@ada2", kind: "agent", status: "inbox", id: "m1" }]));
  const line = document.querySelector("[data-speaker-line]") as HTMLElement;
  // An agent by the result's word, so a chip (beside Ada's own), though the index doesn't know it.
  expect(line.querySelectorAll("[style*='width: 20px']")).toHaveLength(2);
});
