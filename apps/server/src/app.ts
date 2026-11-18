import type { Db } from "@open-factory/db";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type postgres from "postgres";
import { type Auth, createAuth } from "./auth/auth.ts";
import type { Config } from "./config.ts";
import { notFoundBody, registerErrorHandlers } from "./errors.ts";
import { authRoutes } from "./routes/auth.ts";
import { meRoutes } from "./routes/me.ts";
import { statusRoutes } from "./routes/status.ts";
import { wsRoutes } from "./ws/route.ts";

declare module "fastify" {
  interface FastifyInstance {
    auth: Auth;
    config: Config;
  }
}

export interface AppDeps {
  db: Db;
  sql: postgres.Sql;
  webRoot?: string;
  logger?: boolean | object;
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

  await app.register(statusRoutes, { sql: deps.sql });
  await app.register(authRoutes);
  await app.register(meRoutes);
  await app.register(wsRoutes);
  // Task 7 registers static serving here.

  app.setNotFoundHandler((_request, reply) => reply.code(404).send(notFoundBody));
  return app;
}
