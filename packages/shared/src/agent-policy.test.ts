import { describe, expect, test } from "vitest";
import {
  type AgentPolicyInput,
  agentPolicyIssues,
  isRefusedEnv,
  refusedReferences,
  touchesLocalRuntime,
} from "./agent-policy.ts";
import type { AgentOverlay, ConfigDoc } from "./config.ts";
import { RESERVED_SETTINGS_KEYS } from "./settings-keys.ts";

const base: ConfigDoc = {
  template: { name: "dev", display_name: "Dev", model: "sonnet" },
  settings: {
    includeCoAuthoredBy: true,
    permissions: { deny: ["Bash(rm:*)"], ask: ["Bash(git push:*)"] },
    autoMode: { hard_deny: ["x"] },
  },
  mcp: { mcpServers: { gh: { command: "gh-mcp" } } },
};

const clone = (d: ConfigDoc): ConfigDoc => structuredClone(d);
const frozen = { runtime: "docker", image: null, permission_mode: "auto" };

type Over = Partial<AgentPolicyInput>;

const issues = (
  after: ConfigDoc | AgentOverlay,
  over: Over = {},
  before: ConfigDoc | AgentOverlay = base,
) =>
  agentPolicyIssues({
    target: "template",
    before,
    after,
    frozen,
    ...over,
  });
const messages = (...args: Parameters<typeof issues>) => issues(...args).map((i) => i.message);

/** A copy of `base` with `edit` applied to it. */
const edited = (edit: (d: ConfigDoc) => void): ConfigDoc => {
  const d = clone(base);
  edit(d);
  return d;
};
const settingsOf = (d: ConfigDoc) =>
  d.settings as { permissions: Record<string, unknown>; autoMode: Record<string, unknown> };

describe("rule 1: everything off the allowlist is byte-equal", () => {
  test("an edit that leaves a human's other keys alone passes", () =>
    expect(messages(edited((d) => (d.template.model = "opus")))).toEqual([]));

  test("changing a human-set key is refused with its path", () => {
    const got = issues(edited((d) => (d.settings.includeCoAuthoredBy = false)));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      severity: "error",
      file: "settings.json",
      path: "settings.includeCoAuthoredBy",
      message: "settings.includeCoAuthoredBy can only be changed by a human.",
    });
  });

  test("deleting a human-set key is refused", () =>
    expect(messages(edited((d) => delete d.settings.includeCoAuthoredBy))).toEqual([
      "settings.includeCoAuthoredBy can only be changed by a human.",
    ]));

  test("adding a key outside the allowlist is refused once", () =>
    expect(
      messages(edited((d) => (d.settings.statusLine = { type: "command", command: "x" }))),
    ).toEqual(["settings.statusLine can only be changed by a human."]));

  test("an unknown top-level key of mcp.json is held byte-equal", () =>
    expect(messages(edited((d) => ((d.mcp as Record<string, unknown>).other = 1)))).toEqual([
      "mcp.other can only be changed by a human.",
    ]));

  test("the derived local_skill_names key is not judged", () =>
    expect(messages(edited((d) => (d.template.local_skill_names = ["a"])))).toEqual([]));

  test.each(["constructor", "toString", "valueOf", "hasOwnProperty"])(
    "an added %s key is not read as an inherited property",
    (key) =>
      expect(
        messages(edited((d) => ((d.settings as Record<string, unknown>)[key] = null))),
      ).toEqual([`settings.${key} can only be changed by a human.`]),
  );

  test("an own __proto__ key (from JSON) is refused too", () => {
    const after = clone(base);
    after.settings = JSON.parse(
      JSON.stringify({ ...base.settings, x: 1 }).replace('"x":1', '"__proto__":{}'),
    );
    expect(Object.hasOwn(after.settings, "__proto__")).toBe(true);
    expect(messages(after)).toEqual(["settings.__proto__ can only be changed by a human."]);
  });

  test("an agent can add a deny rule to a settings file that had no permissions", () =>
    expect(
      messages(
        {
          template: {},
          settings: { permissions: { deny: ["Bash(x:*)"] } },
          mcp: { mcpServers: {} },
        },
        { frozen: undefined },
        { template: {}, settings: {}, mcp: { mcpServers: {} } },
      ),
    ).toEqual([]));
});

describe("rule 2: restrictions are add-only", () => {
  test("adding a deny rule passes", () =>
    expect(
      messages(edited((d) => (settingsOf(d).permissions.deny = ["Bash(rm:*)", "Bash(sudo:*)"]))),
    ).toEqual([]));

  test.each([
    [
      "deny",
      (d: ConfigDoc) => (settingsOf(d).permissions.deny = []),
      "Deny rules can only be removed by a human.",
    ],
    [
      "ask",
      (d: ConfigDoc) => (settingsOf(d).permissions.ask = []),
      "Ask rules can only be removed by a human.",
    ],
    [
      "hard_deny",
      (d: ConfigDoc) => (settingsOf(d).autoMode.hard_deny = []),
      "Restrictions can only be removed by a human.",
    ],
    [
      "deny by deleting the key",
      (d: ConfigDoc) => delete settingsOf(d).permissions.deny,
      "Deny rules can only be removed by a human.",
    ],
  ])("removing a %s entry is refused", (_n, edit, message) =>
    expect(messages(edited(edit))).toEqual([message]),
  );

  test("an overlay's deny and ask lists are add-only too", () => {
    const run = (after: AgentOverlay, before: AgentOverlay) =>
      messages(after, { target: "overlay", frozen: undefined }, before);
    const was: AgentOverlay = { settings: { permissions: { deny: ["a", "b"], ask: ["c"] } } };
    expect(run({ settings: { permissions: { deny: ["a", "b", "z"], ask: ["c"] } } }, was)).toEqual(
      [],
    );
    expect(run({ settings: { permissions: { deny: ["a"], ask: ["c"] } } }, was)).toEqual([
      "Deny rules can only be removed by a human.",
    ]);
    expect(run({ settings: { permissions: { deny: ["a", "b"], ask: [] } } }, was)).toEqual([
      "Ask rules can only be removed by a human.",
    ]);
  });

  test("removing a soft_deny entry is refused", () =>
    expect(
      messages(
        edited((d) => (settingsOf(d).autoMode.soft_deny = [])),
        {},
        edited((d) => (settingsOf(d).autoMode.soft_deny = ["x"])),
      ),
    ).toEqual(["Restrictions can only be removed by a human."]));

  test("the issue points at the removed item", () =>
    expect(issues(edited((d) => (settingsOf(d).permissions.deny = [])))[0]?.path).toBe(
      "settings.permissions.deny.0",
    ));
});

describe("rule 3: frozen boundary fields", () => {
  test.each([
    ["runtime", { runtime: "local" }],
    ["image", { image: "x" }],
    ["permission_mode", { permission_mode: "bypass" }],
  ])("changing %s is refused with its name", (field, change) =>
    expect(messages(edited((d) => Object.assign(d.template, change)))).toEqual([
      `${field} can only be changed by a human.`,
    ]),
  );

  test("restating the frozen values, or leaving the defaults implicit, passes", () =>
    expect(
      messages(
        edited((d) => Object.assign(d.template, { runtime: "docker", permission_mode: "auto" })),
      ),
    ).toEqual([]));

  test("a frozen field is held byte-equal when the caller gives no frozen values", () =>
    expect(
      messages(
        edited((d) => (d.template.runtime = "local")),
        { frozen: undefined },
      ),
    ).toEqual(["template.runtime can only be changed by a human."]));
});

describe("rule 4: env names and references", () => {
  test.each([
    "https_proxy",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "GIT_ASKPASS_HELPER",
    "NODE_OPTIONS",
    "PATH",
    "OPEN_FACTORY_AGENT_TOKEN",
  ])("%s is refused in settings.env, template secrets and an MCP server's env", (name) => {
    const want = [`${name} can only be set by a human.`];
    expect(messages(edited((d) => (d.settings.env = { [name]: "x" })))).toEqual(want);
    expect(messages(edited((d) => (d.template.secrets = [name])))).toEqual(want);
    expect(
      messages(edited((d) => (d.mcp.mcpServers.gh = { command: "x", env: { [name]: "x" } }))),
    ).toEqual(want);
  });

  test("an ordinary name passes everywhere", () =>
    expect(
      messages(
        edited((d) => {
          d.settings.env = { LOG_LEVEL: "debug" };
          d.template.secrets = ["LOG_LEVEL"];
          d.mcp.mcpServers.gh = { command: "x", env: { LOG_LEVEL: "1" } };
        }),
      ),
    ).toEqual([]));

  test("a refused name a human already set stays", () => {
    const withProxy = edited((d) => (d.settings.env = { HTTPS_PROXY: "http://p" }));
    expect(messages(withProxy, {}, withProxy)).toEqual([]);
  });

  test("changing the value of a refused name a human set is refused", () =>
    expect(
      messages(
        edited((d) => (d.settings.env = { HTTPS_PROXY: "http://evil" })),
        {},
        edited((d) => (d.settings.env = { HTTPS_PROXY: "http://p" })),
      ),
    ).toEqual(["HTTPS_PROXY can only be set by a human."]));

  test("an overlay's env and secrets are judged the same way", () =>
    expect(
      messages(
        { settings: { env: { NODE_OPTIONS: "x" } }, template: { secrets: ["PATH"] } },
        { target: "overlay", frozen: undefined },
        {},
      ),
    ).toEqual(["PATH can only be set by a human.", "NODE_OPTIONS can only be set by a human."]));

  test.each([
    [
      "headers",
      { url: "https://h", headers: { Authorization: "Bearer ${CLAUDE_CODE_OAUTH_TOKEN}" } },
    ],
    ["command", { command: "${PATH}/x" }],
    ["url with a default", { url: "https://h/${ANTHROPIC_API_KEY:-x}" }],
  ])("a %s reference to a refused name is refused", (_n, server) => {
    const got = messages(edited((d) => (d.mcp.mcpServers.gh = server)));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatch(/^MCP server gh can't reference [A-Z_]+\.$/);
  });

  test("a reference to a refused name is matched case-insensitively", () =>
    expect(messages(edited((d) => (d.mcp.mcpServers.gh = { command: "${path}/x" })))).toEqual([
      "MCP server gh can't reference path.",
    ]));

  test("the refusal names the variable and points at the string", () => {
    const got = issues(
      edited(
        (d) =>
          (d.mcp.mcpServers.gh = {
            url: "https://h",
            headers: { Authorization: "Bearer ${CLAUDE_CODE_OAUTH_TOKEN}" },
          }),
      ),
    );
    expect(got).toMatchObject([
      {
        file: "mcp.json",
        path: "mcp.mcpServers.gh.headers.Authorization",
        message: "MCP server gh can't reference CLAUDE_CODE_OAUTH_TOKEN.",
      },
    ]);
  });

  test("a reference to an ordinary variable passes", () =>
    expect(
      messages(edited((d) => (d.mcp.mcpServers.gh = { command: "x", env: { T: "${GH_TOKEN}" } }))),
    ).toEqual([]));

  test("a reference inside an unchanged server a human wrote is left alone", () => {
    const human = edited((d) => (d.mcp.mcpServers.old = { command: "${PATH}/x" }));
    const after = clone(human);
    after.template.model = "opus";
    expect(messages(after, {}, human)).toEqual([]);
  });

  test("isRefusedEnv is case-insensitive over names, prefixes and suffixes", () => {
    expect(isRefusedEnv("hTTps_Proxy")).toBe(true);
    expect(isRefusedEnv("claude_code_anything")).toBe(true);
    expect(isRefusedEnv("MY_HELPER")).toBe(true);
    expect(isRefusedEnv("CLAUDE_CONFIG_DIR")).toBe(true);
    expect(isRefusedEnv("LOG_LEVEL")).toBe(false);
    expect(isRefusedEnv("HELPER_X")).toBe(false);
  });

  test("refusedReferences finds references in nested strings and arrays only for refused names", () =>
    expect(
      refusedReferences({
        args: ["--a=${PATH}", "${GH_TOKEN}"],
        nested: { deep: ["x ${ANTHROPIC_API_KEY:-d} y"] },
        n: 3,
      }),
    ).toEqual(["PATH", "ANTHROPIC_API_KEY"]));
});

describe("rule 6: MCP servers", () => {
  test("a server named factory is refused", () =>
    expect(messages(edited((d) => (d.mcp.mcpServers.factory = { command: "x" })))).toEqual([
      "That server name is reserved.",
    ]));

  test("a factory server a human already set is not re-flagged", () => {
    const withFactory = edited((d) => (d.mcp.mcpServers.factory = { command: "x" }));
    expect(messages(withFactory, {}, withFactory)).toEqual([]);
  });

  test("adding, changing and removing another server passes", () => {
    expect(messages(edited((d) => (d.mcp.mcpServers.new = { url: "https://h" })))).toEqual([]);
    expect(messages(edited((d) => (d.mcp.mcpServers.gh = { command: "other" })))).toEqual([]);
    expect(messages(edited((d) => delete d.mcp.mcpServers.gh))).toEqual([]);
  });
});

describe("rule 7: reserved settings keys", () => {
  test.each(RESERVED_SETTINGS_KEYS)("an agent adding %s to settings is refused", (key) => {
    const after = clone(base);
    const parts = key.split(".");
    let cur = after.settings as Record<string, unknown>;
    for (const part of parts.slice(0, -1)) {
      cur[part] ??= {};
      cur = cur[part] as Record<string, unknown>;
    }
    cur[parts.at(-1) as string] = "x";
    const got = issues(after);
    expect(got).toHaveLength(1);
    expect(got[0]?.message).toBe(`settings.${key} can only be changed by a human.`);
  });
});

describe("rule 8: no local runtime", () => {
  test.each([
    { templateRuntime: "local" as const },
    { templateHasLocalAgents: true },
    { agentRuntime: "local" as const },
    { canSpawnRuntimes: ["docker", "local"] },
  ])("%j touches the local runtime", (input) => expect(touchesLocalRuntime(input)).toBe(true));

  test("an all-docker input does not", () =>
    expect(
      touchesLocalRuntime({
        templateRuntime: "docker",
        templateHasLocalAgents: false,
        agentRuntime: "docker",
        canSpawnRuntimes: ["docker"],
      }),
    ).toBe(false));

  test("an empty input does not", () => expect(touchesLocalRuntime({})).toBe(false));
});
