import type { AgentRow } from "@open-factory/db";
import type { ConfigDoc } from "@open-factory/shared";
import { describe, expect, test } from "vitest";
import { ApiError } from "../errors.ts";
import { ConfigResolver, configOf } from "./config-resolver.ts";
import { AgentStartError, forSpawnedAgent } from "./errors.ts";

const baseDoc = (): ConfigDoc => ({
  template: {
    name: "dev",
    display_name: "Dev",
    runtime: "docker",
    skills: ["grilling"],
    secrets: ["GH_TOKEN"],
    max_live_spawns: 2,
  },
  settings: { permissions: { deny: ["Bash(curl:*)"] } },
  mcp: { mcpServers: { a: { command: "secret-cmd", args: ["--token", "s3cr3t"] } } },
});

type Fake = { loadValid: (name: string) => Promise<{ doc: ConfigDoc }> };
const resolverWith = (load: Fake["loadValid"]) =>
  new ConfigResolver({ templates: { loadValid: load } as never });
const resolverFor = (doc: ConfigDoc = baseDoc()) => resolverWith(async () => ({ doc }));

const agent = (over: Omit<Partial<AgentRow>, "config"> & { config?: unknown } = {}): AgentRow =>
  ({
    id: "a1",
    slug: "ana",
    template: "dev",
    kind: "persistent",
    runtime: "local",
    config: {},
    ...over,
  }) as AgentRow;

describe("configOf", () => {
  test("parses a doc carrying the derived local_skill_names (I2 §7.2), which the strict yaml schema would refuse", () => {
    const doc = baseDoc();
    doc.template.local_skill_names = ["release"];
    expect(configOf(doc, "local")).toMatchObject({
      name: "dev",
      runtime: "local",
      skills: ["grilling"],
    });
    expect(configOf({ ...doc, template: { ...doc.template, bogus: 1 } }, "local")).toBeUndefined();
  });
});

describe("ConfigResolver.effective", () => {
  test("an empty overlay is exactly the template", async () => {
    const e = await resolverFor().effective(agent());
    expect(e.doc).toEqual(baseDoc());
    expect(e.config.skills).toEqual(["grilling"]);
    expect(e.config.maxLiveSpawns).toBe(2);
  });

  test("merges the overlay into the template, settings and mcp", async () => {
    const e = await resolverFor().effective(
      agent({
        config: {
          template: { skills: ["review"], model: "opus", secrets: ["NPM_TOKEN"] },
          settings: { permissions: { deny: ["Bash(rm:*)"] } },
          mcp: { mcpServers: { b: { command: "x" } } },
        },
      }),
    );
    expect(e.config.skills).toEqual(["grilling", "review"]);
    expect(e.config.secrets).toEqual(["GH_TOKEN", "NPM_TOKEN"]);
    expect(e.config.model).toBe("opus");
    expect(e.doc.settings).toEqual({ permissions: { deny: ["Bash(curl:*)", "Bash(rm:*)"] } });
    expect(Object.keys(e.doc.mcp.mcpServers)).toEqual(["a", "b"]);
  });

  test("runtime is overwritten from the row", async () => {
    const e = await resolverFor().effective(agent({ runtime: "local" }));
    expect(e.config.runtime).toBe("local");
    expect(e.doc.template.runtime).toBe("docker");
  });

  test("a spawned agent ignores its config", async () => {
    const e = await resolverFor().effective(
      agent({ kind: "ephemeral", config: { template: { skills: ["review"] }, bogus: 1 } }),
    );
    expect(e.doc).toEqual(baseDoc());
    expect(e.config.skills).toEqual(["grilling"]);
  });

  test("a missing template has no fix", async () => {
    const r = resolverWith(async () => {
      throw new ApiError(409, "template_missing", "Template dev no longer exists.");
    });
    const err = await r.effective(agent()).catch((e) => e);
    expect(err).toBeInstanceOf(AgentStartError);
    expect(err.message).toBe("Template dev no longer exists.");
    expect(err.fix).toBeUndefined();
  });

  test("a template name that isn't found reads as missing", async () => {
    const r = resolverWith(async () => {
      throw new ApiError(404, "template_not_found", "Template dev not found.");
    });
    const err = await r.effective(agent()).catch((e) => e);
    expect(err.message).toBe("Template dev no longer exists.");
    expect(err.fix).toBeUndefined();
  });

  test("an invalid template fixes in Templates", async () => {
    const r = resolverWith(async () => {
      throw new ApiError(409, "template_invalid", "Template dev has errors.", { issues: [] });
    });
    const err = await r.effective(agent()).catch((e) => e);
    expect(err).toBeInstanceOf(AgentStartError);
    expect(err.message).toBe("Template dev has errors. Fix it in Templates.");
    expect(err.fix).toBe("template");
  });

  test("an invalid overlay fixes in Configuration and never prints a value", async () => {
    const err = await resolverFor()
      .effective(agent({ config: { template: { model: "-bad" }, leaked: "s3cr3t-value" } }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(AgentStartError);
    expect(err.message).toBe("The configuration of @ana is invalid. Fix it in Configuration.");
    expect(err.fix).toBe("config");
    expect(JSON.stringify(err.message)).not.toContain("s3cr3t");
  });

  test("an overlay that breaks the merged template is invalid", async () => {
    const err = await resolverFor()
      .effective(agent({ config: { template: { max_live_spawns: 999 } } }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(AgentStartError);
    expect(err.fix).toBe("config");
  });

  test("other errors pass through", async () => {
    const r = resolverWith(async () => {
      throw new Error("disk");
    });
    await expect(r.effective(agent())).rejects.toThrow("disk");
  });

  test("a spawned agent's overlay error drops the fix and its advice", async () => {
    const err = new AgentStartError(
      "The configuration of @ana is invalid. Fix it in Configuration.",
      "config",
      "The configuration of @ana is invalid.",
    );
    const spawned = forSpawnedAgent(err);
    expect(spawned.fix).toBeUndefined();
    expect(spawned.message).toBe(
      "The configuration of @ana is invalid. Terminate it and spawn a new one.",
    );
  });
});
