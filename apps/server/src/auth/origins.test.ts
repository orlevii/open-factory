import { expect, test } from "vitest";
import { loadConfig } from "../config.ts";
import { trustedOrigins } from "./origins.ts";

const env = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  FACTORY_SECRET_KEY: "x".repeat(32),
  PUBLIC_URL: "https://factory.example/",
};

test("development trusts PUBLIC_URL's origin and DEV_WEB_ORIGIN", () => {
  expect(trustedOrigins(loadConfig(env))).toEqual([
    "https://factory.example",
    "http://localhost:5173",
  ]);
});

test("production trusts only PUBLIC_URL's origin", () => {
  expect(trustedOrigins(loadConfig({ ...env, NODE_ENV: "production" }))).toEqual([
    "https://factory.example",
  ]);
});
