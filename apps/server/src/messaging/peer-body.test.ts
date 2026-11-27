import { expect, test } from "vitest";
import { type PeerBodyEvent, peerBody, peerLeftOf } from "./peer-body.ts";

const dev = { ref: "k7x2m9qd", displayName: "Developer" };
const LEAD = "p2n4m6k8";
const HR = "h4r5r6r7";
const mention = (ref: string) => `<@${ref}>`;

test("bodies name the subject and the moved-to manager by mention", () => {
  expect(peerBody(dev, "peer", { kind: "peer_joined" }, LEAD)).toBe(
    "<@k7x2m9qd> (Developer) joined as your peer.",
  );
  expect(peerBody(dev, "report", { kind: "peer_joined" }, LEAD)).toBe(
    "<@k7x2m9qd> (Developer) joined as your report.",
  );
  expect(peerBody(dev, "peer", { kind: "peer_left", left: { reason: "archived" } }, LEAD)).toBe(
    "<@k7x2m9qd> (Developer) left: archived.",
  );
  expect(
    peerBody(
      dev,
      "peer",
      { kind: "peer_left", left: { reason: "moved", to: mention(LEAD) } },
      "q1q1q1q1",
    ),
  ).toBe("<@k7x2m9qd> (Developer) left: now reports to <@p2n4m6k8>.");
});

test("a peer-left body names the terminator by mention and parses back", () => {
  const body = peerBody(
    dev,
    "peer",
    { kind: "peer_left", left: { reason: "terminated", by: mention(HR) } },
    LEAD,
  );
  expect(body).toBe("<@k7x2m9qd> (Developer) left: terminated by <@h4r5r6r7>.");
  expect(peerLeftOf(body)).toEqual({ reason: "terminated", by: mention(HR) });
});

test.each<PeerBodyEvent & { kind: "peer_left" }>([
  { kind: "peer_left", left: { reason: "archived" } },
  { kind: "peer_left", left: { reason: "moved", to: mention(LEAD) } },
  { kind: "peer_left", left: { reason: "terminated", by: mention(HR) } },
  { kind: "peer_left", left: { reason: "terminated", by: "@factory" } },
])("peerLeftOf reads back what peerBody wrote: %j", (change) => {
  expect(peerLeftOf(peerBody(dev, "peer", change, LEAD))).toEqual(change.left);
});

test("a display name that looks like a body doesn't fool the parse (anchored at the end)", () => {
  const tricky = { ref: "x2x2x2x2", displayName: "a left: now reports to <@p2n4m6k8>." };
  expect(
    peerLeftOf(peerBody(tricky, "peer", { kind: "peer_left", left: { reason: "archived" } }, LEAD)),
  ).toEqual({ reason: "archived" });
});

test("anything else reads as no move information", () => {
  expect(peerLeftOf("<@k7x2m9qd> (Developer) joined as your peer.")).toBeUndefined();
  expect(peerLeftOf("free text")).toBeUndefined();
});

test("the TTL names no principal", () => {
  expect(
    peerBody(
      dev,
      "peer",
      { kind: "peer_left", left: { reason: "terminated", by: "@factory" } },
      LEAD,
    ),
  ).toBe("<@k7x2m9qd> (Developer) left: terminated after 3 days without activity.");
});

test("an actor's mention is appended before the final full stop (spec §8.2)", () => {
  expect(peerBody(dev, "report", { kind: "peer_joined", by: mention(HR) }, LEAD)).toBe(
    "<@k7x2m9qd> (Developer) joined as your report, by <@h4r5r6r7>.",
  );
  expect(
    peerBody(
      dev,
      "peer",
      { kind: "peer_left", left: { reason: "archived" }, by: mention(HR) },
      LEAD,
    ),
  ).toBe("<@k7x2m9qd> (Developer) left: archived, by <@h4r5r6r7>.");
  expect(
    peerBody(
      dev,
      "peer",
      { kind: "peer_left", left: { reason: "moved", to: mention("q1q1q1q1") }, by: mention(HR) },
      LEAD,
    ),
  ).toBe("<@k7x2m9qd> (Developer) left: now reports to <@q1q1q1q1>, by <@h4r5r6r7>.");
});

test.each<[string, PeerBodyEvent]>([
  ["joined", { kind: "peer_joined" }],
  ["archived", { kind: "peer_left", left: { reason: "archived" } }],
  ["moved", { kind: "peer_left", left: { reason: "moved", to: mention("q1q1q1q1") } }],
])("%s: no suffix when the actor is the recipient or absent", (_n, change) => {
  const plain = peerBody(dev, "peer", change, LEAD);
  expect(plain).not.toContain(", by");
  expect(peerBody(dev, "peer", { ...change, by: mention(LEAD) }, LEAD)).toBe(plain);
});

test.each<PeerBodyEvent & { kind: "peer_left" }>([
  { kind: "peer_left", left: { reason: "archived" }, by: mention(HR) },
  { kind: "peer_left", left: { reason: "moved", to: mention("q1q1q1q1") }, by: mention(HR) },
])("peerLeftOf reads back a body with the actor suffix, unchanged: %j", (change) => {
  expect(peerLeftOf(peerBody(dev, "peer", change, LEAD))).toEqual(change.left);
});
