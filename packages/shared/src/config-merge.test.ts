import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AgentOverlay, ConfigDoc } from "./config.ts";
import { canonicalJson, emptyDoc, mergeConfig, overlayVersion } from "./config-merge.ts";
import { sha256Hex } from "./sha256.ts";

const base: ConfigDoc = {
  template: {
    name: "dev",
    model: "sonnet",
    effort: "medium",
    warm_window_minutes: 70,
    max_live_spawns: 5,
    skills: ["tdd"],
    can_spawn: ["rev"],
    secrets: ["GH_TOKEN"],
  },
  settings: {
    permissions: { allow: ["Read"], deny: ["Bash(rm:*)"] },
    env: { A: "1" },
    autoMode: { environment: ["ci"] },
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard" }] }] },
    x: { y: 1 },
  },
  mcp: { mcpServers: { gh: { command: "npx", args: ["gh"] } } },
};

describe("mergeConfig", () => {
  it.each([
    ["model", "opus"],
    ["effort", "high"],
    ["warm_window_minutes", 30],
    ["max_live_spawns", 1],
  ])("replaces %s", (k, v) =>
    expect(mergeConfig(base, { template: { [k]: v } }).template[k]).toEqual(v),
  );

  it.each(["skills", "can_spawn", "secrets"])("unions %s base first, dropping duplicates", (k) => {
    const withTwo: ConfigDoc = { ...base, template: { [k]: ["b1", "b2"] } };
    expect(mergeConfig(withTwo, { template: { [k]: ["new", "b2", "b1"] } }).template[k]).toEqual([
      "b1",
      "b2",
      "new",
    ]);
  });

  it("unions permissions.allow/deny and autoMode lists", () => {
    const m = mergeConfig(base, {
      settings: {
        permissions: { allow: ["Read", "Edit"], deny: ["WebFetch"] },
        autoMode: { environment: ["ci", "prod"], soft_deny: ["s"], hard_deny: ["h"] },
      },
    });
    expect(m.settings.permissions).toEqual({
      allow: ["Read", "Edit"],
      deny: ["Bash(rm:*)", "WebFetch"],
    });
    expect(m.settings.autoMode).toEqual({
      environment: ["ci", "prod"],
      soft_deny: ["s"],
      hard_deny: ["h"],
    });
  });

  it("unions an unknown nested array (keeps the template hook)", () => {
    const m = mergeConfig(base, {
      settings: { hooks: { PreToolUse: [{ matcher: "Edit", hooks: [] }] } },
    });
    const list = (m.settings.hooks as { PreToolUse: { matcher: string }[] }).PreToolUse;
    expect(list).toHaveLength(2);
    expect(list[0]!.matcher).toBe("Bash");
  });

  it("replaces an env value by name and adds a new name", () => {
    const m = mergeConfig(base, { settings: { env: { A: "2", B: "3" } } });
    expect(m.settings.env).toEqual({ A: "2", B: "3" });
  });

  it("replaces an MCP server whole (stdio → http leaves no command) and adds one", () => {
    const m = mergeConfig(base, {
      mcp: { mcpServers: { gh: { type: "http", url: "https://x" }, pg: { command: "pg" } } },
    });
    expect(m.mcp.mcpServers.gh).toEqual({ type: "http", url: "https://x" });
    expect(Object.keys(m.mcp.mcpServers)).toEqual(["gh", "pg"]);
  });

  it("an overlay deny rule added then removed gives the template list back", () => {
    const withRule: AgentOverlay = { settings: { permissions: { deny: ["WebFetch"] } } };
    const added = mergeConfig(base, withRule);
    expect((added.settings.permissions as { deny: string[] }).deny).toEqual([
      "Bash(rm:*)",
      "WebFetch",
    ]);
    const removed: AgentOverlay = structuredClone(withRule);
    const perms = removed.settings?.permissions as { deny?: string[] };
    delete perms.deny;
    expect(perms).toEqual({});
    expect(mergeConfig(base, removed).settings.permissions).toEqual(base.settings.permissions);
  });

  it("keeps a __proto__ settings key as data and never alters prototypes", () => {
    const overlay = JSON.parse(
      '{"settings":{"__proto__":{"polluted":"yes"},"x":{"__proto__":{"z":2}}}}',
    );
    const m = mergeConfig(base, overlay);
    expect(Object.hasOwn(m.settings, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(m.settings, "__proto__")?.value).toEqual({
      polluted: "yes",
    });
    expect(Object.getPrototypeOf(m.settings)).toBe(Object.prototype);
    expect((m.settings as { polluted?: string }).polluted).toBeUndefined();
    expect(({} as { polluted?: string }).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(m.settings.x)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(m.settings.x, "__proto__")?.value).toEqual({ z: 2 });
  });

  it("deep-merges unknown settings keys", () =>
    expect(mergeConfig(base, { settings: { x: { z: 2 } } }).settings.x).toEqual({ y: 1, z: 2 }));

  it("{} gives exactly the base", () => expect(mergeConfig(base, {})).toEqual(base));

  it("is idempotent", () => {
    const o: AgentOverlay = { template: { skills: ["r"] }, settings: { env: { B: "2" } } };
    expect(mergeConfig(mergeConfig(base, o), o)).toEqual(mergeConfig(base, o));
  });

  it("never mutates its inputs", () => {
    const b = structuredClone(base);
    const o: AgentOverlay = {
      template: { skills: ["r"] },
      settings: { permissions: { deny: ["x"] }, hooks: { PreToolUse: [{ matcher: "E" }] } },
      mcp: { mcpServers: { pg: { command: "pg" } } },
    };
    const oCopy = structuredClone(o);
    const m = mergeConfig(b, o);
    expect(b).toEqual(base);
    expect(o).toEqual(oCopy);
    (m.settings.hooks as { PreToolUse: unknown[] }).PreToolUse.push(1);
    (m.mcp.mcpServers.pg as { command: string }).command = "changed";
    expect(o).toEqual(oCopy);
  });
});

describe("overlayVersion", () => {
  it("ignores key order", () =>
    expect(overlayVersion({ template: { model: "a", effort: "low" } })).toBe(
      overlayVersion({ template: { effort: "low", model: "a" } }),
    ));

  it("changes with content", () =>
    expect(overlayVersion({ template: { model: "a" } })).not.toBe(overlayVersion({})));

  it("is the sha256 hex of the canonical JSON", () => {
    const o: AgentOverlay = { template: { model: "a" } };
    expect(overlayVersion(o)).toBe(createHash("sha256").update(canonicalJson(o)).digest("hex"));
  });
});

describe("sha256Hex", () => {
  it.each(["", "abc", "é世界😀", "a".repeat(55), "a".repeat(56), "a".repeat(64), "a".repeat(1000)])(
    "matches node:crypto for %#",
    (s) => expect(sha256Hex(s)).toBe(createHash("sha256").update(s).digest("hex")),
  );
});

describe("canonicalJson and emptyDoc", () => {
  it("sorts keys at every depth", () =>
    expect(canonicalJson({ b: [{ d: 1, c: 2 }], a: 1 })).toBe('{"a":1,"b":[{"c":2,"d":1}]}'));
  it("emptyDoc is a fresh empty doc", () => {
    expect(emptyDoc()).toEqual({ template: {}, settings: {}, mcp: { mcpServers: {} } });
    expect(emptyDoc()).not.toBe(emptyDoc());
  });
});
