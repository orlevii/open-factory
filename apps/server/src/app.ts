import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { type Db, schema } from "@open-factory/db";
import { createClaudeDriver, type HarnessDriver, localTransport } from "@open-factory/harness";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type postgres from "postgres";
import { AgentService } from "./agents/agent-service.ts";
import { EventBus } from "./agents/event-bus.ts";
import { EventStore } from "./agents/event-store.ts";
import { AgentRuntimes } from "./agents/runtimes.ts";
import { createPrepareStart } from "./agents/start.ts";
import { type Auth, createAuth } from "./auth/auth.ts";
import { type Config, localRuntimeAllowed } from "./config.ts";
import { CredentialService } from "./credentials/credential-service.ts";
import { CredentialVerifier } from "./credentials/verify.ts";
import { Vault } from "./crypto/vault.ts";
import { registerErrorHandlers } from "./errors.ts";
import { ProjectService } from "./projects/project-service.ts";
import { agentsRoutes } from "./routes/agents.ts";
import { authRoutes } from "./routes/auth.ts";
import { credentialsRoutes } from "./routes/credentials.ts";
import { meRoutes } from "./routes/me.ts";
import { projectsRoutes } from "./routes/projects.ts";
import { secretsRoutes } from "./routes/secrets.ts";
import { statusRoutes } from "./routes/status.ts";
import { templatesRoutes } from "./routes/templates.ts";
import { dockerodeClient } from "./runtime/docker/client.ts";
import { ContainerManager } from "./runtime/docker/containers.ts";
import { dockerTransport } from "./runtime/docker/exec-transport.ts";
import { ProcessJournal } from "./runtime/local/journal.ts";
import { SecretService } from "./secrets/secret-service.ts";
import { registerStatic } from "./static.ts";
import { TemplateIndex } from "./templates/template-index.ts";
import { KeyedMutex } from "./workspace/lock.ts";
import { migrateWorkdirState } from "./workspace/state-migration.ts";
import { Workspace } from "./workspace/workspace.ts";
import { wsRoutes } from "./ws/route.ts";

declare module "fastify" {
  interface FastifyInstance {
    auth: Auth;
    config: Config;
    runtimes: AgentRuntimes;
    bus: EventBus;
    store: EventStore;
    vault: Vault;
    workspace: Workspace;
    /** Named workspaceLock because `lock` is a Fastify (websocket plugin) route method. */
    workspaceLock: KeyedMutex;
    templates: TemplateIndex;
    agents: AgentService;
    credentials: CredentialService;
    secrets: SecretService;
    projects: ProjectService;
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
        "*.CLAUDE_CODE_OAUTH_TOKEN",
        "*.env.CLAUDE_CODE_OAUTH_TOKEN",
        "*.*.CLAUDE_CODE_OAUTH_TOKEN",
        "*.ANTHROPIC_API_KEY",
        "*.env.ANTHROPIC_API_KEY",
        "*.*.ANTHROPIC_API_KEY",
        "*.value",
        "*.*.value",
        "*.token",
        "*.env",
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

  await mkdir(config.factoryHome, { recursive: true });
  config.factoryHome = await realpath(config.factoryHome);
  await mkdir(path.join(config.factoryHome, "agents"), { recursive: true });
  await mkdir(path.join(config.factoryHome, "templates"), { recursive: true });

  await migrateWorkdirState(
    config.factoryHome,
    (await deps.db.select({ slug: schema.agents.slug }).from(schema.agents)).map((r) => r.slug),
    app.log,
  );

  const store = new EventStore(deps.db);
  const bus = new EventBus();
  const vault = new Vault(config.secretKey);
  const lock = new KeyedMutex();
  const workspace = new Workspace({
    factoryHome: config.factoryHome,
    hostSkillsDir: config.hostSkillsDir,
    claudeBin: config.claudeBin,
    cliBundle: config.cliBundle,
    lock,
    log: app.log,
  });
  // dockerode connects lazily: constructing these makes no Docker call.
  const docker = dockerodeClient();
  const containers = new ContainerManager({ docker, log: app.log });
  const prepareStart = createPrepareStart({
    db: deps.db,
    config,
    vault,
    workspace,
    lock,
    containers,
  });
  const runtimes = new AgentRuntimes({
    store,
    bus,
    prepareStart,
    log: app.log,
    maxRunningAgents: config.maxRunningAgents,
    localRuntimeAllowed: () => localRuntimeAllowed(config),
    // The same ContainerManager the exec transport stops containers with.
    docker: { containers, claudeBin: config.dockerClaudeBin, defaultImage: config.defaultImage },
    // Only the real driver's processes are ours to journal and reap (spec §12).
    ...(deps.harnessDriver ? {} : { journal: new ProcessJournal() }),
    driver:
      deps.harnessDriver ??
      createClaudeDriver({
        log: app.log,
        transports: { local: localTransport, docker: dockerTransport({ docker, containers }) },
      }),
  });
  const templates = new TemplateIndex({ db: deps.db, config });
  const agents = new AgentService({
    db: deps.db,
    templates,
    workspace,
    lock,
    runtimes,
    log: app.log,
    containers,
  });
  // The verifier's driver has no logger: process output can echo the credential under test.
  const verifier = new CredentialVerifier({
    driver: deps.harnessDriver ?? createClaudeDriver({ transports: { local: localTransport } }),
    claudeBin: config.claudeBin,
  });
  const credentials = new CredentialService({
    db: deps.db,
    vault,
    verifier,
    runtimes,
    log: app.log,
  });
  app.decorate("credentials", credentials);
  app.decorate("secrets", new SecretService({ db: deps.db, vault, runtimes, log: app.log }));
  app.decorate("projects", new ProjectService({ db: deps.db, runtimes, templates, log: app.log }));
  app.decorate("vault", vault);
  app.decorate("templates", templates);
  app.decorate("agents", agents);
  app.decorate("workspaceLock", lock);
  app.decorate("workspace", workspace);
  app.decorate("store", store);
  app.decorate("bus", bus);
  app.decorate("runtimes", runtimes);
  // Stop agents before the DB closes (index.ts closes the DB after app.close()).
  app.addHook("onClose", async () => {
    // The closing latch first (spec §5.6): nothing may start once shutdown has begun.
    runtimes.supervisor.close();
    await runtimes.stopAll();
  });

  await app.register(statusRoutes, { sql: deps.sql });
  await app.register(authRoutes);
  await app.register(meRoutes);
  await app.register(wsRoutes);
  await app.register(agentsRoutes);
  await app.register(credentialsRoutes);
  await app.register(secretsRoutes);
  await app.register(projectsRoutes);
  await app.register(templatesRoutes);
  await registerStatic(app, deps.webRoot);
  return app;
}
