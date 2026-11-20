import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  ConfigError,
  loadConfig,
  localRuntimeAllowed,
  PLACEHOLDER_SECRET,
  removedEnvWarnings,
} from "./config.ts";

const ok = { DATABASE_URL: "postgres://u:p@localhost:5432/db", FACTORY_SECRET_KEY: "x".repeat(32) };

describe("loadConfig", () => {
  test("applies defaults", () => {
    const c = loadConfig(ok);
    expect(c).toMatchObject({
      port: 3000,
      host: "127.0.0.1",
      logLevel: "info",
      publicUrl: "http://localhost:3000",
      publicOrigin: "http://localhost:3000",
      devWebOrigin: "http://localhost:5173",
      isProduction: false,
      factoryHome: path.join(os.homedir(), "open-factory"),
    });
  });
  test("PUBLIC_URL defaults follow PORT; FACTORY_HOME expands ~ and resolves", () => {
    const c = loadConfig({ ...ok, PORT: "4000", FACTORY_HOME: "~/x/../y" });
    expect(c.publicUrl).toBe("http://localhost:4000");
    expect(c.factoryHome).toBe(path.join(os.homedir(), "y"));
  });
  test("S5 defaults", () => {
    const c = loadConfig(ok);
    expect(c.allowLocalRuntime).toBe(false);
    expect(c.defaultImage).toBe("ghcr.io/orlevii/open-factory/base:latest");
    expect(c.dockerClaudeBin).toBe("claude");
    expect(c.agentUrl).toBe("http://host.docker.internal:3001");
    expect(c.cliBundle).toMatch(/apps\/cli\/dist\/open-factory\.js$/);
    expect(path.isAbsolute(c.cliBundle)).toBe(true);
    expect(loadConfig({ ...ok, PORT: "4000" }).agentUrl).toBe("http://host.docker.internal:4001");
  });
  test("PORT=65535 without FACTORY_AGENT_PORT, and hostnames in FACTORY_AGENT_HOST, are config errors", () => {
    expect(() => loadConfig({ ...ok, PORT: "65535" })).toThrow(/FACTORY_AGENT_PORT/);
    expect(loadConfig({ ...ok, PORT: "65535", FACTORY_AGENT_PORT: "65000" }).agentPort).toBe(65000);
    expect(() => loadConfig({ ...ok, FACTORY_AGENT_HOST: "127.0.0.1,my-host" })).toThrow(
      /must be an IP address/,
    );
  });
  test("agent listener settings", () => {
    const c = loadConfig({ ...ok, PORT: "4000" });
    expect(c.agentPort).toBe(4001);
    expect(c.agentHosts).toBeUndefined();
    const o = loadConfig({
      ...ok,
      FACTORY_AGENT_PORT: "0",
      FACTORY_AGENT_HOST: "127.0.0.1, 10.0.0.5",
      FACTORY_AGENT_URL: "http://factory:9000/",
    });
    expect(o.agentPort).toBe(0);
    expect(o.agentHosts).toEqual(["127.0.0.1", "10.0.0.5"]);
    expect(o.agentUrl).toBe("http://factory:9000");
  });
  test("the cap and the debounce are no longer config (S10 Q6): set values are not read", () => {
    const c = loadConfig({
      ...ok,
      FACTORY_MAX_RUNNING_AGENTS: "0",
      FACTORY_MEMBER_UPDATE_DEBOUNCE_SECONDS: "-1",
    });
    expect("maxRunningAgents" in c).toBe(false);
    expect("memberUpdateDebounceMs" in c).toBe(false);
  });
  test("FACTORY_MAX_SPAWNS_PER_HOUR defaults to 20 and is at least 1", () => {
    expect(loadConfig(ok).maxSpawnsPerHour).toBe(20);
    expect(loadConfig({ ...ok, FACTORY_MAX_SPAWNS_PER_HOUR: "3" }).maxSpawnsPerHour).toBe(3);
    expect(() => loadConfig({ ...ok, FACTORY_MAX_SPAWNS_PER_HOUR: "0" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...ok, FACTORY_MAX_SPAWNS_PER_HOUR: "1.5" })).toThrow(ConfigError);
  });
  test("FACTORY_AGENT_PORT can't be PORT (unless 0, any free port)", () => {
    expect(() => loadConfig({ ...ok, PORT: "4000", FACTORY_AGENT_PORT: "4000" })).toThrow(
      /FACTORY_AGENT_PORT must differ from PORT/,
    );
    expect(loadConfig({ ...ok, PORT: "4000", FACTORY_AGENT_PORT: "0" }).agentPort).toBe(0);
  });
  test("FACTORY_ALLOW_LOCAL_RUNTIME only accepts true/false", () => {
    expect(loadConfig({ ...ok, FACTORY_ALLOW_LOCAL_RUNTIME: "true" }).allowLocalRuntime).toBe(true);
    expect(() => loadConfig({ ...ok, FACTORY_ALLOW_LOCAL_RUNTIME: "yes" })).toThrow(ConfigError);
  });
  test("localRuntimeAllowed follows allowLocalRuntime", () => {
    expect(localRuntimeAllowed({ allowLocalRuntime: true })).toBe(true);
    expect(localRuntimeAllowed({ allowLocalRuntime: false })).toBe(false);
  });
  test("reports every problem at once", () => {
    let err: unknown;
    try {
      loadConfig({ FACTORY_SECRET_KEY: "short", PORT: "nope", PUBLIC_URL: "ftp://x" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const msg = (err as ConfigError).issues.join("\n");
    expect(msg).toMatch(/DATABASE_URL/);
    expect(msg).toMatch(/FACTORY_SECRET_KEY/);
    expect(msg).toMatch(/PORT/);
    expect(msg).toMatch(/PUBLIC_URL/);
  });
  test("rejects the .env.example placeholder with a hint", () => {
    expect(() => loadConfig({ ...ok, FACTORY_SECRET_KEY: PLACEHOLDER_SECRET })).toThrow(
      /openssl rand -base64 32/,
    );
  });
  test("empty strings count as unset", () => {
    const c = loadConfig({
      ...ok,
      PORT: "",
      PUBLIC_URL: "",
      HOST: "",
      LOG_LEVEL: "",
      FACTORY_HOME: "",
      DEV_WEB_ORIGIN: "",
      NODE_ENV: "",
    });
    expect(c).toMatchObject({
      port: 3000,
      publicUrl: "http://localhost:3000",
      host: "127.0.0.1",
      logLevel: "info",
      devWebOrigin: "http://localhost:5173",
      factoryHome: path.join(os.homedir(), "open-factory"),
      isProduction: false,
    });
    expect(() => loadConfig({ ...ok, DATABASE_URL: "" })).toThrow(/DATABASE_URL is required/);
  });
  test("PORT must be 1-65535", () => {
    expect(() => loadConfig({ ...ok, PORT: "0" })).toThrow(/PORT/);
    expect(() => loadConfig({ ...ok, PORT: "65536" })).toThrow(/PORT/);
    expect(loadConfig({ ...ok, PORT: "1" }).port).toBe(1);
  });
  test("production flag", () => {
    expect(loadConfig({ ...ok, NODE_ENV: "production" }).isProduction).toBe(true);
  });
  test("host skills dir defaults to ~/.claude/skills and expands ~", () => {
    const c = loadConfig({ DATABASE_URL: "x", FACTORY_SECRET_KEY: "k".repeat(40) });
    expect(c.hostSkillsDir).toBe(path.join(os.homedir(), ".claude", "skills"));
    expect(
      loadConfig({
        DATABASE_URL: "x",
        FACTORY_SECRET_KEY: "k".repeat(40),
        FACTORY_HOST_SKILLS_DIR: "~/s",
      }).hostSkillsDir,
    ).toBe(path.join(os.homedir(), "s"));
    expect("claudeToken" in c).toBe(false);
  });
});

describe("removedEnvWarnings", () => {
  test("names each removed variable that is still set", () => {
    expect(removedEnvWarnings({ FACTORY_MAX_RUNNING_AGENTS: "4" })).toEqual([
      "FACTORY_MAX_RUNNING_AGENTS is no longer read; set it in Settings → Factory.",
    ]);
    expect(
      removedEnvWarnings({
        FACTORY_MAX_RUNNING_AGENTS: "4",
        FACTORY_MEMBER_UPDATE_DEBOUNCE_SECONDS: "0",
      }),
    ).toEqual([
      "FACTORY_MAX_RUNNING_AGENTS is no longer read; set it in Settings → Factory.",
      "FACTORY_MEMBER_UPDATE_DEBOUNCE_SECONDS is no longer read; set it in Settings → Factory.",
    ]);
  });
  test("unset or empty: no warning", () => {
    expect(removedEnvWarnings(ok)).toEqual([]);
    expect(removedEnvWarnings({ FACTORY_MAX_RUNNING_AGENTS: "" })).toEqual([]);
  });
});

describe("FACTORY_TIMEZONE", () => {
  test("unset: the server's resolved zone, or UTC", () => {
    expect(loadConfig(ok).factoryTimezone).toBe(
      new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    );
  });
  test("a valid IANA name is used", () => {
    expect(loadConfig({ ...ok, FACTORY_TIMEZONE: "Europe/Berlin" }).factoryTimezone).toBe(
      "Europe/Berlin",
    );
  });
  test("an unknown zone is a boot error with the zone sentence", () => {
    expect(() => loadConfig({ ...ok, FACTORY_TIMEZONE: "Mars/Base" })).toThrow(
      /FACTORY_TIMEZONE Unknown time zone 'Mars\/Base'; use an IANA name such as Europe\/Berlin\./,
    );
  });
  test("empty means not set", () => {
    expect(loadConfig({ ...ok, FACTORY_TIMEZONE: "" }).factoryTimezone).toBeTruthy();
  });
});
