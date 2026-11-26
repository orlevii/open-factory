import { expect, test } from "vitest";
import { treeOrder } from "./tree.ts";

const agent = (handle: string) => ({ kind: "agent" as const, ref: "aaaaaaaa", handle });
const user = (handle: string) => ({ kind: "human" as const, ref: "hhhhhhhh", handle });

test("depth-first, siblings by display name; a human or unknown manager makes a root", () => {
  const rows = [
    { slug: "dev", displayName: "Dev", reportsTo: agent("lead") },
    { slug: "lead", displayName: "Lead", reportsTo: user("or") },
    { slug: "alpha", displayName: "Alpha", reportsTo: agent("lead") },
    { slug: "orphan", displayName: "Orphan", reportsTo: agent("archived-boss") },
  ];
  expect(treeOrder(rows)).toEqual([
    { slug: "lead", depth: 0 },
    { slug: "alpha", depth: 1 },
    { slug: "dev", depth: 1 },
    { slug: "orphan", depth: 0 },
  ]);
});
