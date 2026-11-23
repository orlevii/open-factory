import { describe, expect, it } from "vitest";
import {
  agentOverlaySchema,
  CONFIG_MSG,
  ENV_NAME,
  FACTORY_ENV_NAMES,
  isFactoryEnvName,
  OVERLAY_LIMITS,
} from "./config.ts";
import { MODEL_ALIASES, MODEL_IDS, MODEL_MSG, modelSchema } from "./models.ts";

describe("agentOverlaySchema", () => {
  it("accepts {} and keeps it {} (no defaults)", () => {
    expect(agentOverlaySchema.parse({})).toEqual({});
    expect(agentOverlaySchema.parse({ template: {} })).toEqual({ template: {} });
  });
  it.each([
    "model",
    "effort",
    "warm_window_minutes",
    "max_live_spawns",
    "skills",
    "plugins",
    "can_spawn",
    "secrets",
  ])("accepts template.%s", (k) => {
    const v = {
      model: "opus",
      effort: "high",
      warm_window_minutes: 30,
      max_live_spawns: 2,
      skills: ["release"],
      plugins: ["x@y"],
      can_spawn: ["dev"],
      secrets: ["GH_TOKEN"],
    } as Record<string, unknown>;
    expect(agentOverlaySchema.safeParse({ template: { [k]: v[k] } }).success).toBe(true);
  });
  it.each([
    "name",
    "display_name",
    "description",
    "runtime",
    "image",
    "permission_mode",
    "projects",
    "local_skills",
    "bogus",
  ])("refuses template.%s", (k) => {
    expect(agentOverlaySchema.safeParse({ template: { [k]: "x" } }).success).toBe(false);
  });
  it("refuses unknown top-level keys and extra mcp keys", () => {
    expect(agentOverlaySchema.safeParse({ other: {} }).success).toBe(false);
    expect(agentOverlaySchema.safeParse({ mcp: { mcpServers: {}, x: 1 } }).success).toBe(false);
  });
  it("refuses extraKnownMarketplaces and permissions.defaultMode in settings", () => {
    expect(agentOverlaySchema.safeParse({ settings: { extraKnownMarketplaces: {} } }).success).toBe(
      false,
    );
    expect(
      agentOverlaySchema.safeParse({ settings: { permissions: { defaultMode: "auto" } } }).success,
    ).toBe(false);
    expect(
      agentOverlaySchema.safeParse({ settings: { permissions: { deny: ["Bash(rm:*)"] } } }).success,
    ).toBe(true);
  });
  it("refuses factory env names in settings.env and secrets", () => {
    expect(
      agentOverlaySchema.safeParse({ settings: { env: { ANTHROPIC_API_KEY: "x" } } }).success,
    ).toBe(false);
    expect(
      agentOverlaySchema.safeParse({ template: { secrets: ["OPEN_FACTORY_X"] } }).success,
    ).toBe(false);
    expect(
      agentOverlaySchema.safeParse({ settings: { env: { LOG_LEVEL: "debug" } } }).success,
    ).toBe(true);
  });
  it("refuses a bad env name in settings.env", () => {
    expect(agentOverlaySchema.safeParse({ settings: { env: { "1BAD": "x" } } }).success).toBe(
      false,
    );
    expect(agentOverlaySchema.safeParse({ settings: { env: { "A-B": "x" } } }).success).toBe(false);
  });
  it("does not echo a secret-shaped value in an env error", () => {
    const secret = "sk-ant-api03-AbCdEf0123456789_realistic-looking-key";
    const r = agentOverlaySchema.safeParse({ settings: { env: { ANTHROPIC_API_KEY: secret } } });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).not.toContain(secret);
    const r2 = agentOverlaySchema.safeParse({ settings: { env: { "bad name": secret } } });
    expect(r2.success).toBe(false);
    expect(JSON.stringify(r2.error?.issues)).not.toContain(secret);
  });
  it("uses a constant message for unknown keys and never echoes the key", () => {
    const secret = "sk-ant-api03-ZyXwVu9876543210_realistic-looking-key";
    for (const v of [
      { [secret]: 1 },
      { template: { [secret]: 1 } },
      { mcp: { mcpServers: {}, [secret]: 1 } },
    ]) {
      const r = agentOverlaySchema.safeParse(v);
      expect(r.success).toBe(false);
      expect(r.error?.issues.map((i) => i.message)).toEqual([CONFIG_MSG.unknownField]);
      for (const i of r.error?.issues ?? []) expect(i.message).not.toContain(secret);
    }
  });
  it("does not echo a secret-shaped item in secrets", () => {
    const secret = "sk-ant-api03-QrStUv5555555555_realistic-looking-key";
    const r = agentOverlaySchema.safeParse({ template: { secrets: [secret] } });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).not.toContain(secret);
  });
  it("counts bytes, not UTF-16 units, for value and total limits", () => {
    const wide = "é".repeat(OVERLAY_LIMITS.value / 2 + 1); // 16K+1 chars, 32K+2 bytes
    expect(agentOverlaySchema.safeParse({ settings: { env: { A: wide } } }).success).toBe(false);
    const item = "é".repeat(OVERLAY_LIMITS.item / 2 + 1);
    expect(
      agentOverlaySchema.safeParse({ settings: { permissions: { deny: [item] } } }).success,
    ).toBe(false);
    const v = "é".repeat(OVERLAY_LIMITS.value / 2);
    const env = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`K${i}`, v]));
    // 5 x 32 KB is 160 KB (ok); 9 x 32 KB is 288 KB (over). A UTF-16 length count would see half of that.
    const more = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`K${i}`, v]));
    expect(agentOverlaySchema.safeParse({ settings: { env } }).success).toBe(true);
    expect(agentOverlaySchema.safeParse({ settings: { env: more } }).success).toBe(false);
  });
  it("keeps every message at 40 characters or fewer", () => {
    for (const m of [...Object.values(CONFIG_MSG), ...Object.values(MODEL_MSG)])
      expect(m.length).toBeLessThanOrEqual(40);
  });
  it("refuses an MCP server named factory and more than 50 servers", () => {
    expect(agentOverlaySchema.safeParse({ mcp: { mcpServers: { factory: {} } } }).success).toBe(
      false,
    );
    const many = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`s${i}`, { command: "x" }]));
    expect(agentOverlaySchema.safeParse({ mcp: { mcpServers: many(51) } }).success).toBe(false);
    expect(agentOverlaySchema.safeParse({ mcp: { mcpServers: many(50) } }).success).toBe(true);
  });
  it("enforces list, item, value and total size limits", () => {
    const skills = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`);
    expect(agentOverlaySchema.safeParse({ template: { skills: skills(201) } }).success).toBe(false);
    expect(agentOverlaySchema.safeParse({ template: { skills: skills(200) } }).success).toBe(true);
    const deny = (s: string) => ({ settings: { permissions: { deny: [s] } } });
    expect(agentOverlaySchema.safeParse(deny("x".repeat(1001))).success).toBe(false);
    expect(agentOverlaySchema.safeParse(deny("x".repeat(1000))).success).toBe(true);
    const env = (s: string) => ({ settings: { env: { A: s } } });
    expect(agentOverlaySchema.safeParse(env("x".repeat(OVERLAY_LIMITS.value + 1))).success).toBe(
      false,
    );
    expect(agentOverlaySchema.safeParse(env("x".repeat(OVERLAY_LIMITS.value))).success).toBe(true);
    const big = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`K${i}`, "x".repeat(OVERLAY_LIMITS.value)]),
    );
    expect(agentOverlaySchema.safeParse({ settings: { env: big } }).success).toBe(false);
  });
  it("exports the limits and names", () => {
    expect(OVERLAY_LIMITS).toEqual({
      bytes: 256 * 1024,
      item: 1000,
      value: 32 * 1024,
      listItems: 200,
      mcpServers: 50,
    });
    expect(ENV_NAME.test("GH_TOKEN")).toBe(true);
    expect(ENV_NAME.test("1X")).toBe(false);
    expect(FACTORY_ENV_NAMES).toContain("GIT_COMMITTER_EMAIL");
  });
  it("isFactoryEnvName", () => {
    expect(isFactoryEnvName("CLAUDE_CONFIG_DIR")).toBe(true);
    expect(isFactoryEnvName("OPEN_FACTORY_URL")).toBe(true);
    expect(isFactoryEnvName("GH_TOKEN")).toBe(false);
  });
});

describe("modelSchema", () => {
  it.each(["opus", "fable", "claude-sonnet-5-5[1m]", "claude-opus-5-5"])("accepts %s", (m) =>
    expect(modelSchema.safeParse(m).success).toBe(true),
  );
  it.each(["-x", "opus model", "a;b", "", "x".repeat(101)])("refuses %j", (m) =>
    expect(modelSchema.safeParse(m).success).toBe(false),
  );
  it("keeps messages short and lists the choices", () => {
    for (const m of ["-x", "a;b"]) {
      const r = modelSchema.safeParse(m);
      for (const i of r.error?.issues ?? []) expect(i.message.length).toBeLessThanOrEqual(40);
    }
    expect(MODEL_ALIASES).toEqual(["fable", "opus", "sonnet", "haiku"]);
    expect(MODEL_IDS).toHaveLength(4);
  });
});
