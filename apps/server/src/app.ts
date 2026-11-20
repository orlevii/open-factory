import { mkdir, realpath } from "node:fs/promises";
import os from "node:os";
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
import { bridgeInfo, resolveAgentBindHosts } from "./mcp/bind-hosts.ts";
import { startAgentListener } from "./mcp/listener.ts";
import { createFactoryMcp } from "./mcp/server.ts";
import { AgentTokens } from "./mcp/tokens.ts";
import { listPeersTool } from "./mcp/tools/list-peers.ts";
import { scheduleTools } from "./mcp/tools/schedule-tools.ts";
import { sendMessageTool } from "./mcp/tools/send-message.ts";
import { type SpawnPort, spawnAgentTool } from "./mcp/tools/spawn-agent.ts";
import { taskTools } from "./mcp/tools/task-tools.ts";
import { type TerminatePort, terminateAgentTool } from "./mcp/tools/terminate-agent.ts";
import { Neighborhood } from "./messaging/neighborhood.ts";
import { Router } from "./messaging/router.ts";
import { ProjectService } from "./projects/project-service.ts";
import { agentsRoutes } from "./routes/agents.ts";
import { authRoutes } from "./routes/auth.ts";
import { credentialsRoutes } from "./routes/credentials.ts";
import { inboxRoutes } from "./routes/inbox.ts";
import { meRoutes } from "./routes/me.ts";
import { messagesRoutes } from "./routes/messages.ts";
import { projectsRoutes } from "./routes/projects.ts";
import { secretsRoutes } from "./routes/secrets.ts";
import { statusRoutes } from "./routes/status.ts";
import { tasksRoutes } from "./routes/tasks.ts";
import { templatesRoutes } from "./routes/templates.ts";
import { dockerodeClient } from "./runtime/docker/client.ts";
import { ContainerManager } from "./runtime/docker/containers.ts";
import { dockerTransport } from "./runtime/docker/exec-transport.ts";
import { ProcessJournal } from "./runtime/local/journal.ts";
import { ScheduleService } from "./scheduling/schedule-service.ts";
import { ScheduleStore } from "./scheduling/schedule-store.ts";
import { Scheduler } from "./scheduling/scheduler.ts";
import { SecretService } from "./secrets/secret-service.ts";
import { maySpawn } from "./spawning/may-spawn.ts";
import { Reaper } from "./spawning/reaper.ts";
import { SpawnService } from "./spawning/spawn-service.ts";
import { TerminateService } from "./spawning/terminate-service.ts";
import { registerStatic } from "./static.ts";
import { reconcile } from "./supervisor/reconcile.ts";
import { TaskService } from "./tasks/task-service.ts";
import { TaskStore } from "./tasks/task-store.ts";
import { TemplateIndex } from "./templates/template-index.ts";
import { FACTORY_VERSION } from "./version.ts";
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
    router: Router;
    neighborhood: Neighborhood;
    agentTokens: AgentTokens;
    spawner: SpawnService;
    terminator: TerminateService;
    tasks: TaskService;
    reaper: Reaper;
    schedules: ScheduleService;
    scheduler: Scheduler;
    agentListener: { port: number; close(): Promise<void> };
  }
}

/** Spec §5.3's upgrade note: an S5 setup may still point FACTORY_AGENT_URL at the human port. */
export const AGENT_URL_ON_HUMAN_PORT_WARNING =
  "FACTORY_AGENT_URL points at the human port; set it to the agent listener's port (FACTORY_AGENT_PORT) or Docker agents can't reach the factory tools.";

export interface AppDeps {
  db: Db;
  sql: postgres.Sql;
  webRoot?: string;
  logger?: boolean | object;
  harnessDriver?: HarnessDriver;
  /** The clock of the scheduling timer and service; real time unless a test injects one. */
  clock?: () => Date;
  /** The scheduler's timer functions; the real ones unless a test injects them. */
  schedulerTimers?: {
    setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimer: (t: ReturnType<typeof setTimeout>) => void;
  };
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
  const journal = new ProcessJournal();
  const tokens = new AgentTokens();
  const neighborhood = new Neighborhood(deps.db);
  const prepareStart = createPrepareStart({
    db: deps.db,
    config,
    vault,
    workspace,
    lock,
    containers,
    neighborhood,
  });
  const runtimes = new AgentRuntimes({
    store,
    bus,
    prepareStart,
    tokens,
    log: app.log,
    memberUpdateDebounceMs: config.memberUpdateDebounceMs,
    // S6 §9.1: reports forward through the Router (built below; runtimes are created lazily, after it exists).
    forward: (f) => router.forward(f),
    maxRunningAgents: config.maxRunningAgents,
    localRuntimeAllowed: () => localRuntimeAllowed(config),
    // The same ContainerManager the exec transport stops containers with.
    docker: { containers, claudeBin: config.dockerClaudeBin, defaultImage: config.defaultImage },
    // Only the real driver's processes are ours to journal and reap (spec §12).
    ...(deps.harnessDriver ? {} : { journal }),
    driver:
      deps.harnessDriver ??
      createClaudeDriver({
        log: app.log,
        transports: { local: localTransport, docker: dockerTransport({ docker, containers }) },
      }),
  });
  const templates = new TemplateIndex({ db: deps.db, config });
  const router = new Router({ db: deps.db, store, runtimes, bus, log: app.log, neighborhood });
  // S9: schedules (a `next_run_at` column and one in-process timer), started after boot reconciliation, stopped first.
  const clock = deps.clock ?? (() => new Date());
  const scheduleStore = new ScheduleStore({ db: deps.db });
  const scheduler: Scheduler = new Scheduler({
    db: deps.db,
    store,
    schedules: scheduleStore,
    runtimes,
    bus,
    log: app.log,
    now: clock,
    ...deps.schedulerTimers,
  });
  const schedules = new ScheduleService({
    db: deps.db,
    store,
    schedules: scheduleStore,
    now: clock,
    factoryZone: config.factoryTimezone,
    onChanged: () => {
      scheduler.rearm();
      bus.publishAll({ type: "schedules_changed" });
    },
    statusOf: (a) => runtimes.statusOf(a as Parameters<typeof runtimes.statusOf>[0]),
  });
  app.decorate("schedules", schedules);
  app.decorate("scheduler", scheduler);
  const agents = new AgentService({
    db: deps.db,
    templates,
    workspace,
    lock,
    runtimes,
    log: app.log,
    containers,
    router,
    scheduling: schedules,
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
  app.decorate("neighborhood", neighborhood);
  app.decorate("router", router);
  app.decorate("agentTokens", tokens);
  const spawner = new SpawnService({
    db: deps.db,
    store,
    templates,
    workspace,
    router,
    runtimes,
    config,
    log: app.log,
    closing: () => runtimes.supervisor.closing(),
  });
  app.decorate("spawner", spawner);
  const terminator = new TerminateService({ db: deps.db, store, runtimes, router, log: app.log });
  app.decorate("terminator", terminator);
  const taskStore = new TaskStore({ db: deps.db, clock: () => store.clock() });
  const tasks = new TaskService({
    db: deps.db,
    store,
    tasks: taskStore,
    router,
    runtimes,
    bus,
    log: app.log,
  });
  app.decorate("tasks", tasks);
  // S7 §10.3: the spawned-agent sweep, started after boot reconciliation, stopped first on close.
  const reaper = new Reaper({
    store,
    runtimes,
    terminator,
    workspace,
    containers,
    log: app.log,
    now: () => Date.now(),
  });
  app.decorate("reaper", reaper);
  let agentListener: { port: number; close(): Promise<void> } | undefined;
  // Stop agents before the DB closes (index.ts closes the DB after app.close()).
  app.addHook("onClose", async () => {
    // A send still waiting for a boot that failed must not hold the agent listener open.
    router.close();
    reaper.stop();
    scheduler.stop();
    // The closing latch first (spec §5.6): nothing may start once shutdown has begun. Then hibernate("shutdown").
    await runtimes.close();
    // Every process has exited: no token may outlive it (spec §5.2). Then the agent listener (§5.3).
    tokens.revokeAll();
    await agentListener?.close();
    // A sweep that was under way finishes against a closing factory (nothing starts); the DB closes after this hook.
    await reaper.idle();
    await scheduler.idle();
  });

  if (new URL(config.agentUrl).port === String(config.port)) {
    app.log.warn(AGENT_URL_ON_HUMAN_PORT_WARNING);
  }

  await app.register(statusRoutes, { sql: deps.sql });
  await app.register(authRoutes);
  await app.register(meRoutes);
  await app.register(wsRoutes);
  await app.register(agentsRoutes);
  await app.register(credentialsRoutes);
  await app.register(secretsRoutes);
  await app.register(projectsRoutes);
  await app.register(templatesRoutes);
  await app.register(inboxRoutes);
  await app.register(tasksRoutes);
  await app.register(messagesRoutes);
  await registerStatic(app, deps.webRoot);
  // The agent listener (spec §5.3) starts before boot reconciliation: step 6 can start agents, and Claude connects to
  // its MCP servers only at startup. A bind failure fails the boot.
  try {
    agentListener = await listenForAgents(config, {
      docker,
      tokens,
      store,
      router,
      neighborhood,
      runtimes,
      spawner,
      terminator,
      tasks,
      schedules,
      log: app.log,
    });
  } catch (err) {
    await app
      .close()
      .catch((e: unknown) => app.log.error({ err: e }, "closing after a failed boot failed"));
    throw err;
  }
  app.decorate("agentListener", agentListener);
  // Boot reconciliation (spec §5.7): after the migrations, before the server listens. Leftovers of the previous run
  // are reaped (with the real journal whatever the driver: it only ever signals a pid whose start time matches).
  try {
    await reconcile({
      store,
      journal,
      containers,
      supervisor: runtimes.supervisor,
      runtimes,
      memberUpdateDebounceMs: config.memberUpdateDebounceMs,
      forward: (f) => router.forward(f),
      log: app.log,
    });
    router.bootDone();
    void reaper.run();
    reaper.start();
    scheduler.start();
  } catch (err) {
    // A wake may already have started a process. The onClose hook closes the agent listener after the runtimes. A
    // failing close is logged and never masks the boot's error.
    await app
      .close()
      .catch((e: unknown) => app.log.error({ err: e }, "closing after a failed boot failed"));
    throw err;
  }
  return app;
}

/**
 * Binds the agent listener (spec §5.1, §5.3) with the factory MCP behind it. With `FACTORY_AGENT_PORT=0` the port
 * the OS chose becomes `config.agentPort` (and a derived `agentUrl`'s port) before any agent can start.
 */
async function listenForAgents(
  config: Config,
  d: {
    docker: ReturnType<typeof dockerodeClient>;
    tokens: AgentTokens;
    store: EventStore;
    router: Router;
    neighborhood: Neighborhood;
    runtimes: AgentRuntimes;
    spawner: SpawnPort;
    terminator: TerminatePort;
    tasks: TaskService;
    schedules: ScheduleService;
    log: FastifyInstance["log"];
  },
) {
  const bind = resolveAgentBindHosts({
    platform: process.platform,
    ...(config.agentHosts ? { override: config.agentHosts } : {}),
    ...(process.platform === "linux" && !config.agentHosts
      ? { bridge: await bridgeInfo(d.docker) }
      : {}),
    interfaces: os.networkInterfaces(),
    localAllowed: localRuntimeAllowed(config),
    warn: (msg) => d.log.warn(msg),
  });
  const mcp = createFactoryMcp({
    version: FACTORY_VERSION,
    onerror: (err) => d.log.error({ err }, "factory MCP request failed"),
    loadCaller: (id) => d.store.agentById(id),
    tools: (caller) => [
      sendMessageTool(d.router),
      ...taskTools({ tasks: d.tasks, loadAgent: (id) => d.store.agentById(id) }),
      // Q12: persistent agents only; a spawned agent never sees the schedule tools.
      ...(caller.kind === "persistent"
        ? scheduleTools({
            schedules: d.schedules,
            factoryZone: config.factoryTimezone,
            loadAgent: (id) => d.store.agentById(id),
          })
        : []),
      listPeersTool({ neighborhood: d.neighborhood, statusOf: (a) => d.runtimes.statusOf(a) }),
      ...(maySpawn(caller)
        ? [
            spawnAgentTool({
              spawn: d.spawner,
              templates: caller.config.canSpawn as [string, ...string[]],
            }),
            terminateAgentTool({ terminate: d.terminator }),
          ]
        : []),
    ],
  });
  const listener = await startAgentListener({
    hosts: bind.hosts,
    optionalHosts: bind.optionalHosts,
    port: config.agentPort,
    allowedSources: bind.allowedSources,
    version: FACTORY_VERSION,
    tokens: d.tokens,
    // An unknown agent is treated like an ended (archived or terminated) one: its token can't act.
    isEnded: async (agentId) => {
      const a = await d.store.agentById(agentId);
      return !a || a.archivedAt !== null || a.terminatedAt !== null;
    },
    mcp,
    log: d.log,
  });
  if (config.agentPort === 0) {
    config.agentPort = listener.port;
    const url = new URL(config.agentUrl);
    if (url.port === "0") {
      url.port = String(listener.port);
      config.agentUrl = url.toString().replace(/\/$/, "");
    }
  }
  d.log.info({ hosts: listener.hosts, port: listener.port }, "agent listener ready");
  return listener;
}
