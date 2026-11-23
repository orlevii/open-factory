import { describe, expect, it } from "vitest";
import type { ConfigDoc } from "./config.ts";
import { describeChanges, summarizeChanges } from "./config-changes.ts";

const doc = (
  p: {
    template?: Record<string, unknown>;
    settings?: Record<string, unknown>;
    mcp?: Record<string, unknown>;
  } = {},
): ConfigDoc => ({
  template: p.template ?? {},
  settings: p.settings ?? {},
  mcp: { mcpServers: p.mcp ?? {} },
});
const diff = (a: Parameters<typeof doc>[0], b: Parameters<typeof doc>[0]) =>
  describeChanges(doc(a), doc(b));

describe("describeChanges", () => {
  it("shows model and effort values", () => {
    expect(diff({ template: { model: "sonnet" } }, { template: { model: "opus" } })).toEqual([
      "model: sonnet → opus",
    ]);
    expect(diff({ template: { effort: "low" } }, { template: { effort: "high" } })).toEqual([
      "effort: low → high",
    ]);
  });

  it("shows numbers", () => {
    expect(
      diff({ template: { warm_window_minutes: 70 } }, { template: { warm_window_minutes: 30 } }),
    ).toEqual(["warm window: 70 → 30 min"]);
    expect(
      diff({ template: { max_live_spawns: 5 } }, { template: { max_live_spawns: 1 } }),
    ).toEqual(["max live spawns: 5 → 1"]);
  });

  it("names added and removed skills, plugins and secrets", () => {
    expect(
      diff(
        { template: { skills: ["tdd"], plugins: ["a@m"], secrets: ["GH_TOKEN"] } },
        { template: { skills: ["release"], plugins: ["a@m", "x@y"], secrets: [] } },
      ),
    ).toEqual([
      "added plugin x@y",
      "added skill release",
      "removed secret GH_TOKEN",
      "removed skill tdd",
    ]);
  });

  it("shows can spawn and template skill changes", () => {
    expect(
      diff(
        { template: { can_spawn: ["rev"], local_skill_names: ["a"] } },
        { template: { can_spawn: ["rev", "x"], local_skill_names: ["b"] } },
      ),
    ).toEqual(["added template skill b", "can spawn: added x", "removed template skill a"]);
  });

  it("shows permission rules in backticks and trust notes without a value", () => {
    const lines = diff(
      {
        settings: {
          permissions: { allow: [], deny: ["Bash(rm:*)"] },
          autoMode: { environment: [] },
        },
      },
      {
        settings: {
          permissions: { allow: ["Bash(git push:*)"], deny: [] },
          autoMode: { environment: ["prod key is sk-ant-api03-SECRETNOTE"] },
        },
      },
    );
    expect(lines).toEqual([
      "added allow rule `Bash(git push:*)`",
      "added trust note",
      "removed deny rule `Bash(rm:*)`",
    ]);
    expect(lines.join("\n")).not.toContain("sk-ant");
  });

  it("autoMode soft_deny and hard_deny are deny rules", () => {
    expect(
      diff(
        { settings: { autoMode: { soft_deny: ["a"] } } },
        { settings: { autoMode: { soft_deny: ["a", "b"], hard_deny: ["c"] } } },
      ),
    ).toEqual(["added deny rule `b`", "added deny rule `c`"]);
  });

  it("env changes name the variable and never its value", () => {
    const lines = diff(
      { settings: { env: { LOG_LEVEL: "info", OLD: "ghp_oldSecretToken1234567890abcdef" } } },
      {
        settings: {
          env: { LOG_LEVEL: "debug", NEW: "sk-ant-api03-newSecretValue0123456789" },
        },
      },
    );
    expect(lines).toEqual(["env LOG_LEVEL changed", "env NEW added", "env OLD removed"]);
    const text = lines.join("\n");
    for (const v of ["debug", "info", "ghp_", "sk-ant"]) expect(text).not.toContain(v);
  });

  it("MCP changes name the server and never command, args, URL or headers", () => {
    const lines = diff(
      {
        mcp: {
          github: {
            command: "npx",
            args: ["gh", "--token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
          },
          gone: { type: "http", url: "https://old.example.com/mcp" },
        },
      },
      {
        mcp: {
          github: {
            type: "http",
            url: "https://api.example.com/mcp",
            headers: { Authorization: "Bearer sk-ant-api03-abcdef" },
          },
          fresh: { command: "node", args: ["--token", "ghp_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"] },
        },
      },
    );
    expect(lines).toEqual([
      "MCP server fresh added",
      "MCP server github changed",
      "MCP server gone removed",
    ]);
    const text = lines.join("\n");
    for (const v of ["https", "--token", "Bearer", "ghp_", "sk-ant", "npx"])
      expect(text).not.toContain(v);
  });

  it("an unknown settings key shows its name, never its value", () => {
    const lines = diff(
      { settings: { apiKeyHelper: "echo sk-ant-api03-one", hooks: { a: 1 } } },
      { settings: { apiKeyHelper: "echo sk-ant-api03-two", hooks: { a: 2 } } },
    );
    expect(lines).toEqual(["settings key apiKeyHelper changed", "settings key hooks changed"]);
    expect(lines.join("\n")).not.toContain("sk-ant");
  });

  it("other permissions and autoMode keys give a settings key line, not a value", () => {
    expect(
      diff(
        { settings: { permissions: { ask: ["Bash(a)"] } } },
        { settings: { permissions: { ask: ["Bash(b)"] }, autoMode: { custom: "x" } } },
      ),
    ).toEqual(["settings key autoMode changed", "settings key permissions changed"]);
  });

  it("shows image, permission mode and template skills", () => {
    expect(
      diff(
        { template: { image: "a", permission_mode: "auto", local_skills: true } },
        { template: { image: "b", permission_mode: "bypass", local_skills: false } },
      ),
    ).toEqual(["image: a → b", "permission mode: auto → bypass", "template skills off"]);
    expect(diff({ template: { local_skills: false } }, { template: {} })).toEqual([
      "template skills on",
    ]);
  });

  it("ignores keys that never reach a running agent", () => {
    expect(
      diff(
        {
          template: {
            name: "a",
            display_name: "A",
            description: "d",
            projects: ["p"],
            runtime: "docker",
          },
        },
        {
          template: {
            name: "b",
            display_name: "B",
            description: "e",
            projects: ["q"],
            runtime: "local",
          },
        },
      ),
    ).toEqual([]);
  });

  it("gives [] for identical docs", () => {
    const d = doc({
      template: { model: "a", skills: ["x"] },
      settings: { env: { A: "1" }, permissions: { allow: ["R"] } },
      mcp: { s: { command: "c" } },
    });
    expect(describeChanges(d, structuredClone(d))).toEqual([]);
  });

  it("is sorted and stable", () => {
    const a = doc();
    const b = doc({
      template: { model: "m", skills: ["z", "a"] },
      settings: { env: { B: "1", A: "1" } },
    });
    const lines = describeChanges(a, b);
    expect(lines).toEqual([...lines].sort());
    expect(describeChanges(a, b)).toEqual(lines);
  });

  it("keeps a rule with a newline on one line", () => {
    const lines = diff({}, { settings: { permissions: { allow: ["a\nb"] } } });
    expect(lines).toEqual(["added allow rule `a b`"]);
  });
});

describe("summarizeChanges", () => {
  it("gives the short form", () =>
    expect(
      summarizeChanges([
        "model: a → b",
        "added skill x",
        "added allow rule `a`",
        "removed deny rule `b`",
      ]),
    ).toBe("model, 1 skill, 2 rules"));

  it("names three kinds then counts the rest", () =>
    expect(
      summarizeChanges([
        "added allow rule `a`",
        "added plugin p",
        "added secret S",
        "added skill s",
        "effort: a → b",
        "env A changed",
        "image: a → b",
      ]),
    ).toBe("1 rule, 1 plugin, 1 secret and 4 more"));

  it("keeps multi-word scalar labels whole", () =>
    expect(
      summarizeChanges([
        "warm window: 70 → 30 min",
        "max live spawns: 5 → 1",
        "permission mode: auto → bypass",
      ]),
    ).toBe("warm window, max live spawns, permission mode"));

  it("names can spawn and template skills kinds", () =>
    expect(
      summarizeChanges(["can spawn: added x", "template skills off", "added template skill y"]),
    ).toBe("can spawn, template skills, 1 template skill"));

  it("is empty for no lines", () => expect(summarizeChanges([])).toBe(""));
});
