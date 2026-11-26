import type { AgentStatus } from "@open-factory/shared";
import { expect, test } from "vitest";
import { refFor } from "@/test/refs";
import {
  ancestorsOf,
  buildTree,
  indentOf,
  isExpanded,
  pruneStored,
  railRefs,
  type TreeNode,
  visibleNodes,
  workingCounts,
} from "./tree-model";

const row = (ref: string, displayName: string, parent?: string) => ({
  ref,
  handle: ref,
  displayName,
  reportsTo: parent
    ? { kind: "agent" as const, ref: parent, handle: parent }
    : { kind: "human" as const, ref: refFor("or"), handle: "or" },
});
const rows = [row("a", "A"), row("b", "B", "a"), row("c", "C", "b"), row("s", "S · ab12", "b")];

test("roots open, the rest closed; stored toggles override; revealed forces open", () => {
  const n = buildTree(rows);
  expect(visibleNodes(n, {}, new Set()).map((x) => x.ref)).toEqual(["a", "b"]);
  expect(visibleNodes(n, { b: true }, new Set()).map((x) => x.ref)).toEqual(["a", "b", "c", "s"]);
  expect(visibleNodes(n, { a: false }, new Set(["a"])).map((x) => x.ref)).toEqual(["a", "b"]);
});

test("buildTree records level, parent and hasChildren", () => {
  const n = buildTree(rows);
  expect(n.find((x) => x.ref === "c")).toEqual({
    ref: "c",
    level: 2,
    parent: "b",
    hasChildren: false,
  });
  expect(n.find((x) => x.ref === "a")?.hasChildren).toBe(true);
  expect(isExpanded(n[0] as never, {}, new Set())).toBe(true);
});

test("working count on collapsed managers counts all working descendants", () => {
  const n = buildTree(rows);
  const status = (s: string) => (s === "c" || s === "s" ? "working" : "idle") as AgentStatus;
  const m = workingCounts(n, status, (s) =>
    isExpanded(n.find((x) => x.ref === s) as TreeNode, {}, new Set()),
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
    railRefs(n, { active: "c", unread: (s) => (s === "b" ? 2 : 0), statusOf: status }),
  ).toEqual(["b", "c", "s"]);
  expect(railRefs(n, { active: null, unread: () => 0, statusOf: () => "idle" })).toEqual([]);
});

test("ancestorsOf", () => expect(ancestorsOf(buildTree(rows), "c")).toEqual(["a", "b"]));

test("pruneStored drops refs that no longer exist", () => {
  expect(pruneStored({ a: true, gone: false }, new Set(["a"]))).toEqual({ a: true });
});
