import { expect, test } from "vitest";
import { treeOrder } from "./tree.ts";

const agent = (ref: string) => ({ kind: "agent" as const, ref, handle: `h-${ref}` });
const user = (ref: string) => ({ kind: "human" as const, ref, handle: `h-${ref}` });
const row = (
  ref: string,
  displayName: string,
  reportsTo: ReturnType<typeof agent> | ReturnType<typeof user>,
) => ({
  ref,
  handle: `h-${ref}`,
  displayName,
  reportsTo,
});

test("depth-first, siblings by display name; a human or unknown manager makes a root", () => {
  const rows = [
    row("devdevde", "Dev", agent("leadlead")),
    row("leadlead", "Lead", user("orhuman1")),
    row("alphalph", "Alpha", agent("leadlead")),
    row("orphanor", "Orphan", agent("archived")),
  ];
  expect(treeOrder(rows)).toEqual([
    { ref: "leadlead", depth: 0 },
    { ref: "alphalph", depth: 1 },
    { ref: "devdevde", depth: 1 },
    { ref: "orphanor", depth: 0 },
  ]);
});

test("a renamed agent keeps its place under its manager", () => {
  const rows = [
    { ...row("leadlead", "Lead", user("orhuman1")), handle: "boss" },
    row("devdevde", "Dev", agent("leadlead")),
  ];
  expect(treeOrder(rows)).toEqual([
    { ref: "leadlead", depth: 0 },
    { ref: "devdevde", depth: 1 },
  ]);
});
