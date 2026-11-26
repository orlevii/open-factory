import { expect, test } from "vitest";
import { type Actor, canChange, forbiddenSentence } from "./permission.ts";

const chain: Record<string, string[]> = { kid: ["dev", "lead"], dev: ["lead"], lead: [], qa: [] };
const managersOf = (id: string) => chain[id] ?? [];
const agent = (id: string): Actor => ({ kind: "agent", id, ref: id, handle: id });
const task = (createdById: string, assigneeAgentId: string | null) => ({
  createdById,
  assigneeAgentId,
});

test("a human may always change", () => {
  const or: Actor = { kind: "human", id: "u", ref: "ref-u", handle: "or" };
  expect(canChange(or, task("dev", null), managersOf)).toBe(true);
});
test("the creator and the assignee may change", () => {
  expect(canChange(agent("qa"), task("qa", null), managersOf)).toBe(true);
  expect(canChange(agent("qa"), task("dev", "qa"), managersOf)).toBe(true);
});
test("a manager above the creator or the assignee, transitively, may change", () => {
  expect(canChange(agent("lead"), task("kid", null), managersOf)).toBe(true);
  expect(canChange(agent("lead"), task("dev", "kid"), managersOf)).toBe(true);
  expect(canChange(agent("dev"), task("dev", "kid"), managersOf)).toBe(true);
});
test("an unrelated agent may not", () => {
  expect(canChange(agent("qa"), task("dev", "kid"), managersOf)).toBe(false);
  expect(canChange(agent("kid"), task("dev", null), managersOf)).toBe(false);
});
test("the refusal names who can", () => {
  expect(forbiddenSentence("T-42", "@lead", "@dev")).toBe(
    "Only T-42's creator (@lead), its assignee (@dev) or their managers can change it; comment on it instead.",
  );
  expect(forbiddenSentence("T-42", "@or", null)).toBe(
    "Only T-42's creator (@or) or their managers can change it; comment on it instead.",
  );
});
