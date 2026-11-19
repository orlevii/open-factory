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
