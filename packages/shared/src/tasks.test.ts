import { expect, test } from "vitest";
import {
  commentBodySchema,
  createTaskToolSchema,
  linkInputSchema,
  parseTaskKey,
  taskBodySchema,
  taskTitleSchema,
  updateTaskToolSchema,
} from "./tasks.ts";

test("parseTaskKey accepts T-42, t-42, 42 and nothing else", () => {
  expect(parseTaskKey("T-42")).toBe(42);
  expect(parseTaskKey("t-42")).toBe(42);
  expect(parseTaskKey(" 42 ")).toBe(42);
  for (const bad of ["T42", "T-", "T-0", "T--1", "x-42", "4.2", "", "T-99999999999"])
    expect(parseTaskKey(bad)).toBeNull();
});

test("title: trimmed, 1–200, one line", () => {
  expect(taskTitleSchema.parse("  Plan  ")).toBe("Plan");
  expect(taskTitleSchema.safeParse("").error?.issues[0]?.message).toBe("Enter a title.");
  expect(taskTitleSchema.safeParse("x".repeat(201)).error?.issues[0]?.message).toBe(
    "Keep the title to 200 characters or fewer.",
  );
  expect(taskTitleSchema.safeParse("a\nb").error?.issues[0]?.message).toBe(
    "Keep the title on one line.",
  );
});

test("body: may be empty, ≤ 64 KB UTF-8; comment: non-empty", () => {
  expect(taskBodySchema.parse("")).toBe("");
  expect(taskBodySchema.safeParse("é".repeat(32_769)).success).toBe(false); // 65,538 bytes
  expect(commentBodySchema.safeParse("   ").success).toBe(false);
});

test("links: url/pr http(s) ≤ 2000, agent slug, file one line ≤ 500", () => {
  expect(
    linkInputSchema.safeParse({ kind: "url", target: "javascript:alert(1)" }).error?.issues[0]
      ?.message,
  ).toBe("Links must be http(s) URLs.");
  expect(
    linkInputSchema.safeParse({ kind: "pr", target: `https://x.io/${"a".repeat(2000)}` }).success,
  ).toBe(false);
  expect(
    linkInputSchema.safeParse({ kind: "pr", target: "https://github.com/a/b/pull/1", title: "PR" })
      .success,
  ).toBe(true);
  expect(linkInputSchema.safeParse({ kind: "file", target: "a\nb" }).success).toBe(false);
  expect(linkInputSchema.safeParse({ kind: "agent", target: "@dev" }).success).toBe(true);
});

test("tool schemas: arrays, nullable assignee, caps", () => {
  expect(
    createTaskToolSchema.safeParse({ title: "t", depends_on: Array(51).fill("T-1") }).success,
  ).toBe(false);
  expect(updateTaskToolSchema.parse({ id: "T-1", assignee: null }).assignee).toBeNull();
  expect(
    updateTaskToolSchema.safeParse({
      id: "T-1",
      links: Array(51).fill({ kind: "file", target: "a" }),
    }).success,
  ).toBe(false);
});
