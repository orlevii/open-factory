import { expect, test } from "vitest";
import { agentConfigQueryOptions, hostSkillsQueryOptions, templateConfigQueryOptions } from "./api";

test("config queries are keyed per agent and template and never served stale", () => {
  expect(agentConfigQueryOptions("ana").queryKey).toEqual(["agent-config", "ana"]);
  expect(templateConfigQueryOptions("dev").queryKey).toEqual(["template-config", "dev"]);
  expect(agentConfigQueryOptions("ana").staleTime).toBe(0);
  expect(templateConfigQueryOptions("dev").staleTime).toBe(0);
  expect(hostSkillsQueryOptions.staleTime).toBe(0);
});
