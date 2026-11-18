import type { Db } from "@open-factory/db";
import { createClaudeDriver, type HarnessDriver } from "@open-factory/harness";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type postgres from "postgres";
import { EventBus } from "./agents/event-bus.ts";
import { EventStore } from "./agents/event-store.ts";
import { AgentRuntimes } from "./agents/runtimes.ts";
import { type Auth, createAuth } from "./auth/auth.ts";
import type { Config } from "./config.ts";
import { registerErrorHandlers } from "./errors.ts";
import { authRoutes } from "./routes/auth.ts";
import { meRoutes } from "./routes/me.ts";
import { statusRoutes } from "./routes/status.ts";
import { registerStatic } from "./static.ts";
import { wsRoutes } from "./ws/route.ts";

declare module "fastify" {
  interface FastifyInstance {
    auth: Auth;
    config: Config;
    runtimes: AgentRuntimes;
    bus: EventBus;
    store: EventStore;
  }
}

export interface AppDeps {
  db: Db;
  sql: postgres.Sql;
  webRoot?: string;
  logger?: boolean | object;
  harnessDriver?: HarnessDriver;
}

export function loggerOptions(config: Config) {
  return {
    level: config.logLevel,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        'res.headers["set-cookie"]',
        "*.password",
        "password",
        "config.claudeToken",
        "claudeToken",
        "*.claudeToken",
        "*.CLAUDE_CODE_OAUTH_TOKEN",
        "*.env.CLAUDE_CODE_OAUTH_TOKEN",
        "*.*.CLAUDE_CODE_OAUTH_TOKEN",
      ],
      censor: "[redacted]",
    },
    ...(config.isProduction ? {} : { transport: { target: "pino-pretty" } }),
  };
}

export async function buildApp(config: Config, deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? loggerOptions(config),
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate("config", config);
  app.decorate("auth", createAuth(config, deps.db));
  registerErrorHandlers(app);

  const store = new EventStore(deps.db);
  const bus = new EventBus();
  const runtimes = new AgentRuntimes({
    store,
    bus,
    config,
    log: app.log,
    driver: deps.harnessDriver ?? createClaudeDriver(app.log),
  });
  app.decorate("store", store);
  app.decorate("bus", bus);
  app.decorate("runtimes", runtimes);
  // Stop agents before the DB closes (index.ts closes the DB after app.close()).
  app.addHook("onClose", async () => {
    await runtimes.stopAll();
  });

  await app.register(statusRoutes, { sql: deps.sql });
  await app.register(authRoutes);
  await app.register(meRoutes);
  await app.register(wsRoutes);
  await registerStatic(app, deps.webRoot);
  return app;
}
