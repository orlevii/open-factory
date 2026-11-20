import { expect, test } from "vitest";
import { treeOrder } from "./tree.ts";

test("depth-first, siblings by display name, unknown managers are roots", () => {
  const rows = [
    { slug: "dev", displayName: "Dev", reportsTo: "lead" },
    { slug: "lead", displayName: "Lead", reportsTo: null },
    { slug: "alpha", displayName: "Alpha", reportsTo: "lead" },
    { slug: "orphan", displayName: "Orphan", reportsTo: "archived-boss" },
  ];
  expect(treeOrder(rows)).toEqual([
    { slug: "lead", depth: 0 },
    { slug: "alpha", depth: 1 },
    { slug: "dev", depth: 1 },
    { slug: "orphan", depth: 0 },
  ]);
});
