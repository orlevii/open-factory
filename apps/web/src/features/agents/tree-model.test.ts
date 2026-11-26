import type { AgentStatus } from "@open-factory/shared";
import { expect, test } from "vitest";
import {
  ancestorsOf,
  buildTree,
  indentOf,
  isExpanded,
  pruneStored,
  railSlugs,
  type TreeNode,
  visibleNodes,
  workingCounts,
} from "./tree-model";

const rows = [
  {
    slug: "a",
    displayName: "A",
    reportsTo: { kind: "human" as const, ref: "hhhhhhhh", handle: "or" },
  },
  {
    slug: "b",
    displayName: "B",
    reportsTo: { kind: "agent" as const, ref: "aaaaaaaa", handle: "a" },
  },
  {
    slug: "c",
    displayName: "C",
    reportsTo: { kind: "agent" as const, ref: "aaaaaaaa", handle: "b" },
  },
  {
    slug: "s",
    displayName: "S · ab12",
    reportsTo: { kind: "agent" as const, ref: "aaaaaaaa", handle: "b" },
  },
];

test("roots open, the rest closed; stored toggles override; revealed forces open", () => {
  const n = buildTree(rows);
  expect(visibleNodes(n, {}, new Set()).map((x) => x.slug)).toEqual(["a", "b"]);
  expect(visibleNodes(n, { b: true }, new Set()).map((x) => x.slug)).toEqual(["a", "b", "c", "s"]);
  expect(visibleNodes(n, { a: false }, new Set(["a"])).map((x) => x.slug)).toEqual(["a", "b"]);
});

test("buildTree records level, parent and hasChildren", () => {
  const n = buildTree(rows);
  expect(n.find((x) => x.slug === "c")).toEqual({
    slug: "c",
    level: 2,
    parent: "b",
    hasChildren: false,
  });
  expect(n.find((x) => x.slug === "a")?.hasChildren).toBe(true);
  expect(isExpanded(n[0] as never, {}, new Set())).toBe(true);
});

test("working count on collapsed managers counts all working descendants", () => {
  const n = buildTree(rows);
  const status = (s: string) => (s === "c" || s === "s" ? "working" : "idle") as AgentStatus;
  const m = workingCounts(n, status, (s) =>
    isExpanded(n.find((x) => x.slug === s) as TreeNode, {}, new Set()),
  );
  expect(m.b).toBe(2);
  expect("a" in m).toBe(false);
});

test("working count reaches through a collapsed ancestor's collapsed child at any depth", () => {
  const n = buildTree(rows);
  const status = (s: string) => (s === "c" ? "working" : "idle") as AgentStatus;
  const m = workingCounts(n, status, () => false);
  expect(m).toEqual({ a: 1, b: 1 });
});

test("indent stops at level 4", () => expect([0, 4, 9].map(indentOf)).toEqual([0, 32, 32]));

test("rail keeps active, unread and badge-worthy agents in tree order", () => {
  const n = buildTree(rows);
  const status = (s: string) =>
    (s === "s" ? "errored" : s === "b" ? "idle" : undefined) as AgentStatus | undefined;
  expect(
    railSlugs(n, { active: "c", unread: (s) => (s === "b" ? 2 : 0), statusOf: status }),
  ).toEqual(["b", "c", "s"]);
  expect(railSlugs(n, { active: null, unread: () => 0, statusOf: () => "idle" })).toEqual([]);
});

test("ancestorsOf", () => expect(ancestorsOf(buildTree(rows), "c")).toEqual(["a", "b"]));

test("pruneStored drops slugs that no longer exist", () => {
  expect(pruneStored({ a: true, gone: false }, new Set(["a"]))).toEqual({ a: true });
});
