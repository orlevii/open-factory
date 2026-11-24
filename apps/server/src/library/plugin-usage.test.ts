import type { ConfigDoc } from "@open-factory/shared";
import { describe, expect, test } from "vitest";
import { type Declarations, declaredRefs, marketplaceUsers, pluginUsers } from "./plugin-usage.ts";

const SHA = "a".repeat(40);
const doc = (declared: Record<string, unknown>, enabled: string[]): ConfigDoc => ({
  template: {},
  settings: {
    extraKnownMarketplaces: declared,
    enabledPlugins: Object.fromEntries(enabled.map((k) => [k, true])),
  },
  mcp: { mcpServers: {} },
});
const gh = (repo: string, ref?: string) => ({
  source: { source: "github", repo, ...(ref ? { ref } : {}) },
});

const d: Declarations = {
  templates: new Map([
    ["dev", doc({ acme: gh("acme/mk", SHA) }, ["foo@acme"])],
    ["ops", doc({ acme: gh("acme/mk"), beta: gh("beta/mk", "v1") }, ["foo@acme", "bar@beta"])],
    ["idle", doc({ gamma: gh("gamma/mk") }, [])],
  ]),
  agents: [
    {
      slug: "ana",
      template: "dev",
      config: { settings: { enabledPlugins: { "baz@acme": true } } },
    },
    { slug: "bob", template: "dev", config: {} },
    { slug: "cy", template: "ops", config: {} },
  ],
};

describe("plugin usage", () => {
  test("a marketplace's users are the templates that declare it or enable a plugin, and the agents that enable one in an overlay", () => {
    expect(marketplaceUsers(d, "acme")).toEqual({ templates: ["dev", "ops"], agents: ["ana"] });
    expect(marketplaceUsers(d, "gamma")).toEqual({ templates: ["idle"], agents: [] });
    expect(marketplaceUsers(d, "nobody")).toEqual({ templates: [], agents: [] });
  });

  test("a plugin's users carry the pin each runs at, an overlay at its template's pin", () => {
    expect(pluginUsers(d, "foo@acme")).toEqual({
      templates: [
        { name: "dev", pin: `commit:${SHA}`, agents: 2 },
        { name: "ops", pin: "latest", agents: 1 },
      ],
      overlays: [],
    });
    expect(pluginUsers(d, "baz@acme").overlays).toEqual([
      { agent: "ana", template: "dev", pin: `commit:${SHA}` },
    ]);
    expect(pluginUsers(d, "bar@beta").templates).toEqual([
      { name: "ops", pin: "tag:v1", agents: 1 },
    ]);
  });

  test("declared refs are the commits and tags declarations hold; Latest holds none", () => {
    expect(declaredRefs(d)).toEqual(
      expect.arrayContaining([
        { marketplace: "acme", ref: SHA },
        { marketplace: "acme", ref: null },
        { marketplace: "beta", ref: "v1" },
        { marketplace: "gamma", ref: null },
      ]),
    );
    expect(declaredRefs(d)).toHaveLength(4);
  });
});
