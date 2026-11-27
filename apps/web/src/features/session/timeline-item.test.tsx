import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { refFor } from "@/test/refs";
import { renderInRouter } from "@/test/render-in-router";
import { envelope } from "@/test/session-fixtures";
import type { Row } from "./rows";
import { Timeline } from "./timeline";

const at = "2026-11-21T10:00:00.000Z";
const text = (seq: number): Row => ({
  kind: "text",
  seq,
  at,
  text: `Text ${seq}`,
  key: `${seq}`,
  head: false,
});
const message = (seq: number, id: string): Row => ({
  kind: "message",
  seq,
  at,
  message: envelope({
    id,
    from: "@or",
    fromKind: "human",
    kind: "message",
    urgent: false,
    body: `Body ${id}`,
  }),
  key: `${seq}:0`,
});
const footer: Row = { kind: "turn_footer", seq: 13, key: "13", durationMs: 5000, costUsd: 0 };

const live = (key: string) =>
  document
    .querySelector(`[data-row="${key}"]`)
    ?.closest("[data-row-wrap]")
    ?.hasAttribute("data-live");

test("data-live only for rows above liveAfter that weren't handed off; turn footers never", async () => {
  renderInRouter(
    <Timeline
      agentRef={refFor("dev")}
      rows={[text(9), text(10), message(11, "m1"), message(12, "m2"), footer]}
      failedIds={new Set()}
      interruptedEnds={new Set()}
      liveAfter={9}
      handedOff={new Set(["12:0"])}
      hasMoreBefore={false}
      onLoadEarlier={async () => false}
      earlierError={false}
      footer={null}
    />,
  );
  await screen.findByText("Text 10");
  expect(live("9")).toBe(false); // on screen before liveAfter
  expect(live("10")).toBe(true);
  expect(live("11:0")).toBe(true);
  expect(live("12:0")).toBe(false); // replaced a queue item that was on screen
  expect(document.querySelectorAll("[data-row-wrap][data-live]")).toHaveLength(2);
  // The footer's wrap carries no data-live.
  const wraps = [...document.querySelectorAll("[data-row-wrap]")];
  expect(wraps.at(-1)?.textContent).toMatch(/^Worked/);
  expect(wraps.at(-1)?.hasAttribute("data-live")).toBe(false);
});
