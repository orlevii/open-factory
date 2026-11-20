import { expect, test } from "vitest";
import { type PeerBodyEvent, peerBody, peerLeftOf } from "./peer-body.ts";

const dev = { slug: "dev", displayName: "Developer" };

test("bodies match the spec's wording", () => {
  expect(peerBody(dev, "peer", { kind: "peer_joined" })).toBe(
    "@dev (Developer) joined as your peer.",
  );
  expect(peerBody(dev, "report", { kind: "peer_joined" })).toBe(
    "@dev (Developer) joined as your report.",
  );
  expect(peerBody(dev, "peer", { kind: "peer_left", left: { reason: "archived" } })).toBe(
    "@dev (Developer) left: archived.",
  );
  expect(peerBody(dev, "peer", { kind: "peer_left", left: { reason: "moved", to: "lead" } })).toBe(
    "@dev (Developer) left: now reports to @lead.",
  );
  expect(peerBody(dev, "report", { kind: "peer_left", left: { reason: "moved", to: null } })).toBe(
    "@dev (Developer) left: now reports to the humans.",
  );
});

test.each<PeerBodyEvent & { kind: "peer_left" }>([
  { kind: "peer_left", left: { reason: "archived" } },
  { kind: "peer_left", left: { reason: "moved", to: "lead-2" } },
  { kind: "peer_left", left: { reason: "moved", to: null } },
])("peerLeftOf reads back what peerBody wrote: %j", (change) => {
  expect(peerLeftOf(peerBody(dev, "peer", change))).toEqual(change.left);
});

test("a display name that looks like a body doesn't fool the parse (anchored at the end)", () => {
  const tricky = { slug: "x", displayName: "a left: now reports to @evil." };
  expect(
    peerLeftOf(peerBody(tricky, "peer", { kind: "peer_left", left: { reason: "archived" } })),
  ).toEqual({ reason: "archived" });
});

test("anything else reads as no move information", () => {
  expect(peerLeftOf("@dev (Developer) joined as your peer.")).toBeUndefined();
  expect(peerLeftOf("free text")).toBeUndefined();
});

test.each([
  [
    { kind: "peer_left", left: { reason: "terminated", by: "@or" } },
    "@tl-ab12 (Tech Lead · ab12) left: terminated by @or.",
  ],
  [
    { kind: "peer_left", left: { reason: "terminated", by: "lead" } },
    "@tl-ab12 (Tech Lead · ab12) left: terminated by @lead.",
  ],
  [
    { kind: "peer_left", left: { reason: "terminated", by: "@factory" } },
    "@tl-ab12 (Tech Lead · ab12) left: terminated after 3 days without activity.",
  ],
])("terminated bodies %#", (c, want) => {
  expect(peerBody({ slug: "tl-ab12", displayName: "Tech Lead · ab12" }, "peer", c as never)).toBe(
    want,
  );
});

test.each([
  ["@or", "@or"],
  ["lead", "@lead"], // the body names the spawner as @slug; prose can't tell a slug from a handle
  ["@factory", "@factory"],
])("peerLeftOf reads a terminated body back: by %s → %s", (by, want) => {
  const body = peerBody({ slug: "tl-ab12", displayName: "Tech Lead · ab12" }, "peer", {
    kind: "peer_left",
    left: { reason: "terminated", by },
  });
  expect(peerLeftOf(body)).toEqual({ reason: "terminated", by: want });
});

test("a display name that looks like a terminated body doesn't fool the parse", () => {
  const tricky = { slug: "x", displayName: "a left: terminated by @evil." };
  expect(
    peerLeftOf(peerBody(tricky, "peer", { kind: "peer_left", left: { reason: "archived" } })),
  ).toEqual({ reason: "archived" });
});
