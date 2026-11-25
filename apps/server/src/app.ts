import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import { ChatStore } from "./agents/chat-store.ts";
import { ConfigChanges, dbConfigChangeAgents } from "./agents/config-changes.ts";
import { ConfigResolver } from "./agents/config-resolver.ts";
import { ConfigService } from "./agents/config-service.ts";
import { EventBus } from "./agents/event-bus.ts";
import { EventStore } from "./agents/event-store.ts";
import { PolicyInputs } from "./agents/policy-inputs.ts";
import { AgentRuntimes } from "./agents/runtimes.ts";
import { createPrepareStart } from "./agents/start.ts";
import { type Auth, createAuth } from "./auth/auth.ts";
import type { PasswordHasher } from "./auth/options.ts";
import { type Config, localRuntimeAllowed, removedEnvWarnings } from "./config.ts";
import { CredentialService } from "./credentials/credential-service.ts";
import { ExpiryCheck } from "./credentials/expiry-check.ts";
import { SignInAttempts } from "./credentials/sign-in/attempts.ts";
import { probePython, startHostPty, sweepStaleDirs } from "./credentials/sign-in/host-pty.ts";
import { runSetupToken } from "./credentials/sign-in/setup-token.ts";
import { CredentialVerifier } from "./credentials/verify.ts";
import { Vault } from "./crypto/vault.ts";
import { registerErrorHandlers } from "./errors.ts";
import { ImageBuilder } from "./images/builder.ts";
import { checkImageClaudeVersion } from "./library/claude-flags.ts";
import { HostPlugins } from "./library/host-plugins.ts";
import { LibraryIndex } from "./library/library-index.ts";
import { LibrarySweep, marketplaceDirsInUse, skillDirsInUse } from "./library/library-sweep.ts";
import { dbMarketplacesStore, MarketplacesService } from "./library/marketplaces-service.ts";
import { declaredRefs, marketplaceUsers } from "./library/plugin-usage.ts";
import { PluginsIndex } from "./library/plugins-index.ts";
import { dbSourcesStore, SourcesService } from "./library/sources-service.ts";
import { bridgeInfo, resolveAgentBindHosts } from "./mcp/bind-hosts.ts";
import { startAgentListener } from "./mcp/listener.ts";
import { createFactoryMcp } from "./mcp/server.ts";
import { AgentTokens } from "./mcp/tokens.ts";
import { listPeersTool } from "./mcp/tools/list-peers.ts";
import { type OrgToolDeps, orgTools } from "./mcp/tools/org-tools.ts";
import { restartAgentTool } from "./mcp/tools/restart-agent.ts";
import { scheduleTools } from "./mcp/tools/schedule-tools.ts";
import { sendCommandTool } from "./mcp/tools/send-command.ts";
import { sendMessageTool } from "./mcp/tools/send-message.ts";
import { type SpawnPort, spawnAgentTool } from "./mcp/tools/spawn-agent.ts";
import { taskTools } from "./mcp/tools/task-tools.ts";
import { type TerminatePort, terminateAgentTool } from "./mcp/tools/terminate-agent.ts";
import { LoopGuard } from "./messaging/loop-guard.ts";
import { LoopResume } from "./messaging/loop-resume.ts";
import { Neighborhood } from "./messaging/neighborhood.ts";
import { Router } from "./messaging/router.ts";
import { ProjectService } from "./projects/project-service.ts";
import { agentsRoutes } from "./routes/agents.ts";
import { authRoutes } from "./routes/auth.ts";
import { claudeSignInRoutes } from "./routes/claude-sign-in.ts";
import { credentialsRoutes } from "./routes/credentials.ts";
import { hostRoutes } from "./routes/host.ts";
import { imagesRoutes } from "./routes/images.ts";
import { inboxRoutes } from "./routes/inbox.ts";
import { libraryRoutes } from "./routes/library.ts";
import { loopHoldsRoutes } from "./routes/loop-holds.ts";
import { meRoutes } from "./routes/me.ts";
import { messagesRoutes } from "./routes/messages.ts";
import { projectsRoutes } from "./routes/projects.ts";
import { schedulesRoutes } from "./routes/schedules.ts";
import { secretsRoutes } from "./routes/secrets.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { statusRoutes } from "./routes/status.ts";
import { tasksRoutes } from "./routes/tasks.ts";
import { templatesRoutes } from "./routes/templates.ts";
import { uploadsRoutes } from "./routes/uploads.ts";
import { usageRoutes } from "./routes/usage.ts";
import { signUpStateRoutes, usersRoutes } from "./routes/users.ts";
import { type DockerClient, dockerodeClient } from "./runtime/docker/client.ts";
import { ContainerManager } from "./runtime/docker/containers.ts";
import { dockerTransport } from "./runtime/docker/exec-transport.ts";
import { ProcessJournal } from "./runtime/local/journal.ts";
import { ScheduleService } from "./scheduling/schedule-service.ts";
import { ScheduleStore } from "./scheduling/schedule-store.ts";
import { Scheduler } from "./scheduling/scheduler.ts";
import { SecretService } from "./secrets/secret-service.ts";
import { FactorySettings } from "./settings/factory-settings.ts";
import { maySpawn } from "./spawning/may-spawn.ts";
import { Reaper } from "./spawning/reaper.ts";
import { SpawnService } from "./spawning/spawn-service.ts";
import { TerminateService } from "./spawning/terminate-service.ts";
import { registerStatic } from "./static.ts";
import { reconcile } from "./supervisor/reconcile.ts";
import { TaskService } from "./tasks/task-service.ts";
import { TaskStore } from "./tasks/task-store.ts";
import { TemplateIndex } from "./templates/template-index.ts";
import { UploadService } from "./uploads/service.ts";
import { UploadSweep } from "./uploads/sweep.ts";
import { UsageService } from "./usage/usage-service.ts";
import { InviteService } from "./users/invites.ts";
import { UserAdminService } from "./users/user-admin.ts";
import { FACTORY_VERSION } from "./version.ts";
import { KeyedMutex } from "./workspace/lock.ts";
import { dockerSocketPaths } from "./workspace/mounts.ts";
import { Workspace } from "./workspace/workspace.ts";
import { wsRoutes } from "./ws/route.ts";

declare module "fastify" {
  interface FastifyInstance {
    auth: Auth;
    config: Config;
    runtimes: AgentRuntimes;
    bus: EventBus;
    store: EventStore;
    chat: ChatStore;
    vault: Vault;
    workspace: Workspace;
    /** Named workspaceLock because `lock` is a Fastify (websocket plugin) route method. */
    workspaceLock: KeyedMutex;
    templates: TemplateIndex;
    /** I2 §6.1: an agent's effective config (the current template plus its overlay). */
    resolver: ConfigResolver;
    /** I2 §7.2: the one change path for template changes and overlay saves. */
    configChanges: ConfigChanges;
    agents: AgentService;
    configs: ConfigService;
    credentials: CredentialService;
    /** I3 §5.4: the in-memory "Sign in with Claude" attempts, one per user. */
    signIn: SignInAttempts;
    /** I3 §5.5: whether a working python3 (with `pty`) is on the host; probed once, then cached. */
    signInAvailable(): Promise<boolean>;
    secrets: SecretService;
    projects: ProjectService;
    router: Router;
    neighborhood: Neighborhood;
    agentTokens: AgentTokens;
    spawner: SpawnService;
    terminator: TerminateService;
    tasks: TaskService;
    usage: UsageService;
    images: ImageBuilder;
    invites: InviteService;
    userAdmin: UserAdminService;
    factorySettings: FactorySettings;
    reaper: Reaper;
    schedules: ScheduleService;
    scheduler: Scheduler;
    agentListener: { port: number; close(): Promise<void> };
    uploads: UploadService;
    /** I5 §5.3: the Library's skills, discovered live. */
    library: LibraryIndex;
    /** I5 §9.2: skill sources (preview, add, check, update, remove, Undo). */
    skillSources: SourcesService;
    /** I5 §7.1, §9.3: the marketplace registry (preview, add, check, update, fetch, remove, Undo). */
    marketplaces: MarketplacesService;
    /** I5 §9.1: the Plugins view (catalogs, contents, diffs, external reads). */
    plugins: PluginsIndex;
    /** I5 §7.6: plugins installed on the host, and Add its marketplace. */
    hostPlugins: HostPlugins;
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
  /** The Docker client; the real (lazily connecting) dockerode client unless a test injects a fake. */
  docker?: DockerClient;
  /** The clock of the scheduling timer and service; real time unless a test injects one. */
  clock?: () => Date;
  /** The scheduler's timer functions; the real ones unless a test injects them. */
  schedulerTimers?: {
    setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimer: (t: ReturnType<typeof setTimeout>) => void;
  };
  /** Spawns the sign-in PTY bridge and the python3 probe (I3); the real `spawn` unless a test injects one. */
  signInSpawn?: typeof spawn;
  /** Checked for the removed env vars (S10 Q6) to warn at boot; `process.env` when absent. */
  env?: NodeJS.ProcessEnv;
  /** better-auth's scrypt when absent; tests inject a cheap one. */
  passwordHasher?: PasswordHasher;
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
  app.decorate("auth", createAuth(config, deps.db, deps.passwordHasher));
  registerErrorHandlers(app);

  await mkdir(config.factoryHome, { recursive: true });
  config.factoryHome = await realpath(config.factoryHome);
  await mkdir(path.join(config.factoryHome, "agents"), { recursive: true });
  await mkdir(path.join(config.factoryHome, "templates"), { recursive: true });
  await mkdir(path.join(config.factoryHome, "images"), { recursive: true });

  // S10 §8.2: the settings row loads before anything that reads it (the runtimes, boot reconciliation).
  const settings = await FactorySettings.load(deps.db, app.log);
  app.decorate("factorySettings", settings);
  for (const w of removedEnvWarnings(deps.env ?? process.env)) app.log.warn(w);

  const store = new EventStore(deps.db);
  const bus = new EventBus();
  const vault = new Vault(config.secretKey);
  const lock = new KeyedMutex();
  // I5 §5.3: the Library validates templates and resolves every start's skills. It reads the template side through a
  // lazy port, because `TemplateIndex` is built with the Library.
  const library = new LibraryIndex({
    db: deps.db,
    hostClaudeDir: config.hostClaudeDir,
    factoryHome: config.factoryHome,
    templates: () => templates,
    checkingSince: (id) => skillSources.checkingSince(id),
  });
  const workspace = new Workspace({
    factoryHome: config.factoryHome,
    library,
    claudeBin: config.claudeBin,
    cliBundle: config.cliBundle,
    lock,
    log: app.log,
  });
  // dockerode connects lazily: constructing these makes no Docker call.
  const docker = deps.docker ?? dockerodeClient();
  const containers = new ContainerManager({
    docker,
    log: app.log,
    checkImage: checkImageClaudeVersion,
  });
  const journal = new ProcessJournal();
  const tokens = new AgentTokens();
  const neighborhood = new Neighborhood(deps.db);
  const policy = new PolicyInputs({ db: deps.db, library });
  const templates: TemplateIndex = new TemplateIndex({
    db: deps.db,
    config,
    library,
    policy,
    log: app.log,
  });
  const resolver = new ConfigResolver({ templates, library });
  const prepareStart = createPrepareStart({
    db: deps.db,
    config,
    vault,
    workspace,
    resolver,
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
    // S10 §8.2: read live; `settingsChanged()` below re-arms the runtimes' timers on a change.
    memberUpdateDebounceMs: settings.memberUpdateDebounceMs,
    defaultWarmWindowMinutes: settings.defaultWarmWindowMinutes,
    // S6 §9.1: reports forward through the Router (built below; runtimes are created lazily, after it exists).
    forward: (f) => router.forward(f),
    // S10 §8.2: the cap is read live; `capChanged()` below grants and publishes on a change.
    maxRunningAgents: settings.maxRunningAgents,
    localRuntimeAllowed: () => localRuntimeAllowed(config),
    // The same ContainerManager the exec transport stops containers with.
    docker: {
      containers,
      claudeBin: config.dockerClaudeBin,
      defaultImage: config.defaultImage,
      resolver,
    },
    // Only the real driver's processes are ours to journal and reap (spec §12).
    ...(deps.harnessDriver ? {} : { journal }),
    driver:
      deps.harnessDriver ??
      createClaudeDriver({
        log: app.log,
        transports: { local: localTransport, docker: dockerTransport({ docker, containers }) },
      }),
  });
  settings.onChange((prev, next) => {
    if (prev.maxRunningAgents !== next.maxRunningAgents) runtimes.supervisor.capChanged();
    if (
      prev.defaultWarmWindowMinutes !== next.defaultWarmWindowMinutes ||
      prev.memberUpdateDebounceSeconds !== next.memberUpdateDebounceSeconds
    )
      void runtimes.settingsChanged();
  });
  const loopGuard = new LoopGuard({
    settings,
    store,
    bus,
    runtimes,
    log: app.log,
    clock: () => store.clock(),
    newId: randomUUID,
  });
  const router = new Router({
    db: deps.db,
    store,
    runtimes,
    bus,
    log: app.log,
    neighborhood,
    loopGuard,
  });
  // I2 §7.1: a template change is dispatched off the scan's path, on a per-template serial queue (never awaited there).
  const configChanges = new ConfigChanges({
    agents: dbConfigChangeAgents(deps.db, resolver),
    store,
    runtimes,
    bus,
    log: app.log,
    resolver,
    templates,
  });
  templates.onChange((e) => configChanges.templateChanged(e));
  // S9: schedules (a `next_run_at` column and one in-process timer), started after boot reconciliation, stopped first.
  const clock = deps.clock ?? (() => new Date());
  const scheduleStore = new ScheduleStore();
  const scheduler: Scheduler = new Scheduler({
    db: deps.db,
    store,
    schedules: scheduleStore,
    loopGuard,
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
    resolver,
    log: app.log,
    containers,
    router,
    store,
    bus,
    configChanges,
    policy,
    scheduling: schedules,
  });
  const configs = new ConfigService({
    db: deps.db,
    templates,
    runtimes,
    resolver,
    policy,
    configChanges,
  });
  app.decorate("configs", configs);
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
    bus,
    now: clock,
    log: app.log,
  });
  app.decorate("credentials", credentials);
  // I3 §5.4: before UserAdminService, which ends a disabled user's attempt.
  const signInSpawn = deps.signInSpawn ?? spawn;
  app.decorate(
    "signIn",
    new SignInAttempts({
      startPty: () => startHostPty({ claudeBin: config.claudeBin, spawnFn: signInSpawn }),
      run: (pty) => runSetupToken(pty),
      verify: (value) => verifier.verify("oauth_token", value),
      credentials,
      now: () => clock().getTime(),
      log: app.log,
    }),
  );
  let pythonProbe: Promise<boolean> | undefined;
  app.decorate("signInAvailable", () => {
    pythonProbe ??= probePython(signInSpawn);
    return pythonProbe;
  });
  app.decorate(
    "usage",
    new UsageService({ db: deps.db, now: clock, timezone: () => config.factoryTimezone }),
  );
  app.decorate(
    "images",
    new ImageBuilder({
      docker,
      imagesRoot: path.join(config.factoryHome, "images"),
      bus,
      now: clock,
      log: app.log,
    }),
  );
  app.decorate(
    "invites",
    new InviteService({ db: deps.db, now: clock, publicUrl: config.publicUrl, bus }),
  );
  app.decorate(
    "userAdmin",
    new UserAdminService({ db: deps.db, now: clock, bus, signIn: app.signIn }),
  );
  app.decorate("secrets", new SecretService({ db: deps.db, vault, runtimes, log: app.log }));
  app.decorate("projects", new ProjectService({ db: deps.db, runtimes, templates, log: app.log }));
  app.decorate("vault", vault);
  app.decorate("templates", templates);
  app.decorate("resolver", resolver);
  app.decorate("configChanges", configChanges);
  app.decorate("agents", agents);
  app.decorate("workspaceLock", lock);
  app.decorate("workspace", workspace);
  app.decorate("store", store);
  app.decorate("chat", new ChatStore(deps.db));
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
    resolver,
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
    loopGuard,
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
  // U3 §13.5: uploads into agent workspaces, and the 24h sweep of unsent ones (started after boot, stopped first).
  const uploads = new UploadService({
    db: deps.db,
    factoryHome: config.factoryHome,
    lock,
    log: app.log,
    now: clock,
  });
  app.decorate("uploads", uploads);
  const uploadSweep = new UploadSweep({ uploads, log: app.log, now: clock });
  const expiryCheck = new ExpiryCheck({
    db: deps.db,
    store,
    bus,
    zone: config.factoryTimezone,
    now: clock,
    log: app.log,
  });
  // I5 §5.3, §9.2, §9.4: the Library's skills and their sources, and the sweep that purges them.
  const sourcesStore = dbSourcesStore(deps.db);
  const libraryChanged = (e?: { addFailed?: string }) =>
    bus.publishAll({
      type: "library_changed",
      ...(e?.addFailed ? { addFailed: e.addFailed } : {}),
    });
  const skillSources: SourcesService = new SourcesService({
    store: sourcesStore,
    usedByAny: (names) => library.usedByAny(names),
    factoryHome: config.factoryHome,
    hostClaudeDir: config.hostClaudeDir,
    forbidden: {
      home: os.homedir(),
      factoryHome: config.factoryHome,
      dockerSockets: dockerSocketPaths(process.env, os.homedir()),
    },
    githubUrl: config.githubUrl,
    publish: libraryChanged,
    purgeAfter: (ms) => librarySweep.purgeAfter(ms),
    // After the Library lock is released (spec §9.6); `by` is the bare user handle.
    captureLibrary: (skills) => configChanges.captureLibrary(skills),
    onLibraryChanged: (e) => configChanges.libraryChanged(e),
    log: (message, err) => app.log.error({ err }, message),
  });
  // The directories a loaded runtime's `started.library` still references: GitHub skill caches and marketplace
  // checkouts at a pinned commit or tag (spec §9.4). Purge keeps them and retries on the next timer.
  const libraryDirsInUse = async (): Promise<string[]> => [
    ...(await skillDirsInUse(skillSources.githubRoot, runtimes.allStarted())),
    ...marketplaceDirsInUse(marketplaces.root, runtimes.allStarted(), await marketplaces.rows()),
  ];
  // A marketplace write moves only the Library's commit: it never calls the config change flow and restarts no
  // agent (spec §8.3), so its only hook is the `library_changed` frame.
  const marketplaces: MarketplacesService = new MarketplacesService({
    store: dbMarketplacesStore(deps.db),
    usedBy: async (name) => marketplaceUsers(await library.declarations(), name),
    inUse: libraryDirsInUse,
    declaredRefs: async () => declaredRefs(await library.declarations()),
    factoryHome: config.factoryHome,
    forbidden: {
      home: os.homedir(),
      factoryHome: config.factoryHome,
      dockerSockets: dockerSocketPaths(process.env, os.homedir()),
    },
    githubUrl: config.githubUrl,
    publish: libraryChanged,
    purgeAfter: (ms) => librarySweep.purgeAfter(ms),
    log: (message, err) => app.log.error({ err }, message),
  });
  const hostPlugins = new HostPlugins({
    hostClaudeDir: config.hostClaudeDir,
    registered: async () => (await library.marketplaces()).map((r) => r.name),
    marketplaces,
    forbidden: {
      home: os.homedir(),
      factoryHome: config.factoryHome,
      dockerSockets: dockerSocketPaths(process.env, os.homedir()),
    },
    log: (message, err) => app.log.error({ err }, message),
  });
  const plugins = new PluginsIndex({
    library,
    marketplaces,
    host: hostPlugins,
    factoryHome: config.factoryHome,
    githubUrl: config.githubUrl,
    publish: libraryChanged,
    log: (message, err) => app.log.error({ err }, message),
  });
  const librarySweep = new LibrarySweep({
    sources: skillSources,
    store: sourcesStore,
    marketplaces,
    factoryHome: config.factoryHome,
    inUse: libraryDirsInUse,
    publish: libraryChanged,
    log: (message, err) => app.log.error({ err }, message),
  });
  app.decorate("library", library);
  app.decorate("skillSources", skillSources);
  app.decorate("marketplaces", marketplaces);
  app.decorate("hostPlugins", hostPlugins);
  app.decorate("plugins", plugins);
  let agentListener: { port: number; close(): Promise<void> } | undefined;
  // Stop agents before the DB closes (index.ts closes the DB after app.close()).
  app.addHook("onClose", async () => {
    // A send still waiting for a boot that failed must not hold the agent listener open.
    router.close();
    expiryCheck.stop();
    reaper.stop();
    uploadSweep.stop();
    scheduler.stop();
    await librarySweep.stop();
    // The closing latch first (spec §5.6): nothing may start once shutdown has begun. Then hibernate("shutdown").
    await runtimes.close();
    // Sign-in attempts hold a host process (I3 §5.4): ended before the DB closes.
    await app.signIn.closeAll();
    // Every process has exited: no token may outlive it (spec §5.2). Then the agent listener (§5.3).
    tokens.revokeAll();
    await agentListener?.close();
    // A sweep that was under way finishes against a closing factory (nothing starts); the DB closes after this hook.
    await reaper.idle();
    await uploadSweep.idle();
    await expiryCheck.idle();
    await scheduler.idle();
    await skillSources.idle();
    await marketplaces.idle();
  });

  if (new URL(config.agentUrl).port === String(config.port)) {
    app.log.warn(AGENT_URL_ON_HUMAN_PORT_WARNING);
  }

  await app.register(statusRoutes, { sql: deps.sql });
  await app.register(authRoutes, { db: deps.db });
  await app.register(meRoutes);
  await app.register(hostRoutes);
  await app.register(libraryRoutes);
  await app.register(wsRoutes);
  await app.register(agentsRoutes);
  await app.register(credentialsRoutes);
  await app.register(claudeSignInRoutes);
  await app.register(usageRoutes);
  await app.register(signUpStateRoutes, { db: deps.db });
  await app.register(usersRoutes);
  await app.register(settingsRoutes, { db: deps.db });
  await app.register(secretsRoutes);
  await app.register(projectsRoutes);
  await app.register(templatesRoutes, { docker });
  await app.register(imagesRoutes, { docker });
  await app.register(inboxRoutes);
  await app.register(loopHoldsRoutes, {
    resume: new LoopResume({ store, guard: loopGuard, router, bus }),
  });
  await app.register(tasksRoutes);
  await app.register(schedulesRoutes);
  await app.register(messagesRoutes);
  await app.register(uploadsRoutes);
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
      resolver,
      spawner,
      terminator,
      tasks,
      schedules,
      org: {
        agents,
        config: configs,
        templates,
        library,
        plugins,
        credentials,
        secrets: app.secrets,
        projects: app.projects,
        bus,
      },
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
      memberUpdateDebounceMs: settings.memberUpdateDebounceMs,
      forward: (f) => router.forward(f),
      log: app.log,
    });
    router.bootDone();
    void reaper.run();
    reaper.start();
    void uploadSweep.run();
    uploadSweep.start();
    void expiryCheck.run();
    expiryCheck.start();
    scheduler.start();
    // I5 §9.4: no Undo survives a restart; interrupted GitHub adds finish in the background. A failed purge is logged, not fatal.
    await librarySweep
      .bootPurge()
      .catch((e: unknown) => app.log.error({ err: e }, "library boot purge failed"));
    librarySweep.start();
    // I3 §5.2: a crashed server's sign-in temp dirs.
    void sweepStaleDirs(os.tmpdir(), clock().getTime());
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
    resolver: ConfigResolver;
    spawner: SpawnPort;
    terminator: TerminatePort;
    tasks: TaskService;
    schedules: ScheduleService;
    /** The services the org tools call; the caller's own row is `store.agentById`. */
    org: Omit<OrgToolDeps, "loadAgent">;
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
    tools: (caller) => {
      // I2 §6.2: the spawn tools describe the running process, so they follow the config it started with.
      const started = d.runtimes.startedOf(caller.id)?.config;
      return [
        sendMessageTool(d.router),
        sendCommandTool({
          caller,
          runtimes: d.runtimes,
          store: d.store,
          resolver: d.resolver,
          spawned: caller.kind === "ephemeral",
        }),
        ...taskTools({ tasks: d.tasks, loadAgent: (id) => d.store.agentById(id) }),
        // Q12 and I7 §9.1: persistent agents only; a spawned agent never sees the schedule or restart tools.
        ...(caller.kind === "persistent"
          ? [
              restartAgentTool({
                caller,
                loadAgent: (id) => d.store.agentById(id),
                store: d.store,
                runtimes: d.runtimes,
                resolver: d.resolver,
                router: d.router,
                localRuntimeAllowed: () => localRuntimeAllowed(config),
              }),
              ...scheduleTools({
                schedules: d.schedules,
                factoryZone: config.factoryTimezone,
                loadAgent: (id) => d.store.agentById(id),
              }),
            ]
          : []),
        listPeersTool({ neighborhood: d.neighborhood, statusOf: (a) => d.runtimes.statusOf(a) }),
        ...(caller.manageOrg
          ? orgTools({ ...d.org, loadAgent: (id) => d.store.agentById(id) })
          : []),
        ...(started && maySpawn(caller, started)
          ? [
              spawnAgentTool({
                spawn: d.spawner,
                templates: started.canSpawn as [string, ...string[]],
              }),
              terminateAgentTool({ terminate: d.terminator }),
            ]
          : []),
      ];
    },
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
