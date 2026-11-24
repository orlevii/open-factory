import type { PutAgentConfigResponse } from "@open-factory/shared";
import { QueryClient } from "@tanstack/react-query";
import { expect, test } from "vitest";
import {
  agentConfigQueryOptions,
  cacheSavedAgentConfig,
  saveAgentConfigMutation,
  templateConfigQueryOptions,
} from "./api";

test("config queries are keyed per agent and template and never served stale", () => {
  expect(agentConfigQueryOptions("ana").queryKey).toEqual(["agent-config", "ana"]);
  expect(templateConfigQueryOptions("dev").queryKey).toEqual(["template-config", "dev"]);
  expect(agentConfigQueryOptions("ana").staleTime).toBe(0);
  expect(templateConfigQueryOptions("dev").staleTime).toBe(0);
});

test("a saved config replaces the cached GET without its save-only fields", () => {
  const qc = new QueryClient();
  const r: PutAgentConfigResponse = {
    overlay: { template: { model: "opus" } },
    version: "v2",
    template: { name: "dev", doc: null, valid: false },
    merged: null,
    plugins: [],
    issues: [],
    changes: ["model: sonnet → opus"],
    restartChecked: true,
    checked: "schema",
  };
  cacheSavedAgentConfig(qc, "ana", r);
  expect(qc.getQueryData(agentConfigQueryOptions("ana").queryKey)).toEqual({
    overlay: { template: { model: "opus" } },
    version: "v2",
    template: { name: "dev", doc: null, valid: false },
    merged: null,
    plugins: [],
    issues: [],
  });
  expect(saveAgentConfigMutation("ana").mutationKey).toEqual(["agent-config", "ana", "save"]);
});
