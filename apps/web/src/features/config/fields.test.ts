import { expect, test } from "vitest";
import { fieldForPath } from "./fields";

test("issue paths map to their field, with the item for a list row", () => {
  expect(fieldForPath("template.model")).toEqual({ field: "model" });
  expect(fieldForPath("template.warm_window_minutes")).toEqual({ field: "warmWindow" });
  expect(fieldForPath("settings.permissions.allow.3")).toEqual({ field: "allow", item: "3" });
  expect(fieldForPath("settings.permissions.deny")).toEqual({ field: "deny" });
  expect(fieldForPath("settings.autoMode.environment.0")).toEqual({
    field: "trustNotes",
    item: "0",
  });
  expect(fieldForPath("settings.env.GH_X")).toEqual({ field: "env", item: "GH_X" });
  expect(fieldForPath("template.secrets.1")).toEqual({ field: "envSecrets", item: "1" });
  expect(fieldForPath("template.can_spawn.0")).toEqual({ field: "canSpawn", item: "0" });
  expect(fieldForPath("mcp.mcpServers.github.env.TOKEN")).toEqual({
    field: "mcp",
    item: "github.env.TOKEN",
  });
  expect(fieldForPath("mcp.mcpServers.ctx.io.url")).toEqual({ field: "mcp", item: "ctx.io.url" });
});

test("a path no field owns maps to nothing", () => {
  expect(fieldForPath("settings.hooks.PreToolUse.0")).toBeNull();
  expect(fieldForPath("settings.permissions")).toBeNull();
  expect(fieldForPath("")).toBeNull();
  expect(fieldForPath("template.modelx")).toBeNull();
});
