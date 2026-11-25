import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { ConfigError, loadConfig, PLACEHOLDER_SECRET } from "./config.ts";

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
  test("EXTRA_PUBLIC_ORIGINS adds origins after PUBLIC_URL's, once each; TRUST_PROXY lists IPs and CIDR ranges", () => {
    const c = loadConfig({
      ...ok,
      PUBLIC_URL: "https://factory.example.com",
      EXTRA_PUBLIC_ORIGINS: "http://127.0.0.1:3000/, https://factory.example.com",
      TRUST_PROXY: "127.0.0.1, 10.0.0.0/8, ::1",
    });
    expect(c.publicOrigins).toEqual(["https://factory.example.com", "http://127.0.0.1:3000"]);
    expect(c.trustProxy).toEqual(["127.0.0.1", "10.0.0.0/8", "::1"]);
    expect(loadConfig(ok).trustProxy).toBeUndefined();
  });
  test.each([
    ["EXTRA_PUBLIC_ORIGINS", "127.0.0.1:3000", /EXTRA_PUBLIC_ORIGINS entry "127.0.0.1:3000"/],
    ["EXTRA_PUBLIC_ORIGINS", "http://x.io/app", /must be an http\(s\) origin/],
    ["EXTRA_PUBLIC_ORIGINS", "ftp://x.io", /must be an http\(s\) origin/],
    ["TRUST_PROXY", "true", /TRUST_PROXY entry "true"/],
    ["TRUST_PROXY", "proxy.local", /must be an IP address or a CIDR range/],
    ["TRUST_PROXY", "10.0.0.0/33", /must be an IP address or a CIDR range/],
  ])("%s=%s is a config error", (key, value, msg) => {
    expect(() => loadConfig({ ...ok, [key]: value })).toThrow(msg);
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
  test("host Claude dir defaults to ~/.claude and expands ~", () => {
    const c = loadConfig({ DATABASE_URL: "x", FACTORY_SECRET_KEY: "k".repeat(40) });
    expect(c.hostClaudeDir).toBe(path.join(os.homedir(), ".claude"));
    expect(
      loadConfig({
        DATABASE_URL: "x",
        FACTORY_SECRET_KEY: "k".repeat(40),
        FACTORY_HOST_CLAUDE_DIR: "~/c",
      }).hostClaudeDir,
    ).toBe(path.join(os.homedir(), "c"));
    expect("claudeToken" in c).toBe(false);
  });
  test("GitHub base URL defaults to github.com; a file:// fixture is accepted", () => {
    expect(loadConfig(ok).githubUrl).toBe("https://github.com");
    expect(loadConfig({ ...ok, FACTORY_GITHUB_URL: "file:///tmp/fixtures/" }).githubUrl).toBe(
      "file:///tmp/fixtures",
    );
    expect(() => loadConfig({ ...ok, FACTORY_GITHUB_URL: "ftp://x" })).toThrow(
      /FACTORY_GITHUB_URL/,
    );
  });
  test.each(["https://u:tok@github.com", "https://tok@github.com"])(
    "a GitHub base URL with credentials (%s) is refused at boot",
    (url) => {
      expect(() => loadConfig({ ...ok, FACTORY_GITHUB_URL: url })).toThrow(
        /FACTORY_GITHUB_URL.*username or password/s,
      );
    },
  );
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
    expect(loadConfig({ ...ok, FACTORY_TIMEZONE: "" }).factoryTimezone).toBe(
      loadConfig(ok).factoryTimezone,
    );
  });
});
