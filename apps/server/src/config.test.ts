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
  test("production flag", () => {
    expect(loadConfig({ ...ok, NODE_ENV: "production" }).isProduction).toBe(true);
  });
});
