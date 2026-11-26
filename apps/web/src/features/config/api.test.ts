import type { PutAgentConfigResponse } from "@open-factory/shared";
import { QueryClient } from "@tanstack/react-query";
import { expect, test } from "vitest";
import { refFor } from "@/test/refs";
import {
  agentConfigQueryOptions,
  cacheSavedAgentConfig,
  saveAgentConfigMutation,
  templateConfigQueryOptions,
} from "./api";

test("config queries are keyed per agent and template and never served stale", () => {
  expect(agentConfigQueryOptions(refFor("ana")).queryKey).toEqual(["agent-config", refFor("ana")]);
  expect(templateConfigQueryOptions("dev").queryKey).toEqual(["template-config", "dev"]);
  expect(agentConfigQueryOptions(refFor("ana")).staleTime).toBe(0);
  expect(templateConfigQueryOptions("dev").staleTime).toBe(0);
});

test("a saved config replaces the cached GET without its save-only fields", () => {
  const qc = new QueryClient();
  const r: PutAgentConfigResponse = {
    overlay: { template: { model: "opus" } },
    version: "v2",
    template: { name: "dev", doc: null, valid: false },
    merged: null,
    issues: [],
    changes: ["model: sonnet → opus"],
    restartChecked: true,
    checked: "schema",
  };
  cacheSavedAgentConfig(qc, refFor("ana"), r);
  expect(qc.getQueryData(agentConfigQueryOptions(refFor("ana")).queryKey)).toEqual({
    overlay: { template: { model: "opus" } },
    version: "v2",
    template: { name: "dev", doc: null, valid: false },
    merged: null,
    issues: [],
  });
  expect(saveAgentConfigMutation(refFor("ana")).mutationKey).toEqual([
    "agent-config",
    refFor("ana"),
    "save",
  ]);
});
