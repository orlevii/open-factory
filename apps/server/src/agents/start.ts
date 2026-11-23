import { stat } from "node:fs/promises";
import { type AgentRow, type Db, schema } from "@open-factory/db";
import type { AgentRuntimeSpec } from "@open-factory/harness";
import { type TemplateConfig, templateConfigSchema } from "@open-factory/shared";
import { asc, eq } from "drizzle-orm";
import { type Config, LOCAL_RUNTIME_START_MESSAGE, localRuntimeAllowed } from "../config.ts";
import { type Vault, VaultError } from "../crypto/vault.ts";
import { resolveImage } from "../images/resolve.ts";
import type { Neighborhood } from "../messaging/neighborhood.ts";
import type { ContainerManager } from "../runtime/docker/containers.ts";
import { dockerStartError } from "../runtime/docker/errors.ts";
import { MAX_AGENT_SCHEDULES, MIN_AGENT_GAP_MINUTES } from "../scheduling/limits.ts";
import { type Inherited, inheritFrom, readDenyRules } from "../spawning/inherit.ts";
import { maySpawn } from "../spawning/may-spawn.ts";
import { WorkspaceError } from "../workspace/links.ts";
import type { KeyedMutex } from "../workspace/lock.ts";
import type { MountCheckContext } from "../workspace/mounts.ts";
import type { Workspace } from "../workspace/workspace.ts";
import { AgentArchivedError, AgentStartError } from "./errors.ts";
import { liveCredentialId } from "./live-credential.ts";
import { buildAgentEnv, buildRuntimeSpec } from "./runtime-spec.ts";

/**
 * What a Docker start still has to do outside the workspace lock (spec §10 step 4): `ContainerManager.ensure` with the
 * image and the same mount-check context `prepare` checked the mounts with.
 */
export interface DockerLaunch {
  image: string;
  mountCheck: MountCheckContext;
}

/**
 * The spec of one start; a Docker start also carries its `launch`. `credentialId` is the credential the process runs
 * on (a spawned agent's is its spawner's current one). Neither is passed to the driver.
 */
export type PreparedSpec = AgentRuntimeSpec & { launch?: DockerLaunch; credentialId: string };

/** `extra.agentToken` is this launch's token (spec §5.2): it goes to the process env and nowhere else. */
export type PrepareStart = (
  agent: AgentRow,
  extra: { agentToken: string },
) => Promise<PreparedSpec>;

export const CLI_BUNDLE_MISSING = "Build the CLI first (pnpm build).";

/** Spec §11.6: the CLI bundle is mounted into every Docker agent; a missing one fails the start. */
async function assertCliBundle(file: string): Promise<void> {
  const st = await stat(file).catch(() => undefined);
  if (!st?.isFile()) throw new AgentStartError(CLI_BUNDLE_MISSING);
}

type Granted = Extract<Inherited, { ok: true }>;

/**
 * S7 §6.3: a spawned agent's inheritance, derived from its spawner's current state at every start (no snapshot):
 * secrets = template ∩ spawner's, deny rules = template ∪ spawner's (from the spawner's factory-owned template copy),
 * grants = spawner's current grants ∩ template projects, and the §6.2 refusals re-checked. Anything about the spawner
 * that can't be read fails the start closed: a child never runs with more than its spawner holds.
 */
export async function deriveInheritance(
  d: { db: Db; config: Config; workspace: Workspace },
  agent: AgentRow,
  config: TemplateConfig,
): Promise<{ spawner: AgentRow; inherited: Granted }> {
  const child = `@${agent.slug}`;
  const [spawner] = agent.reportsTo
    ? await d.db.select().from(schema.agents).where(eq(schema.agents.id, agent.reportsTo))
    : [];
  if (!spawner)
    throw new AgentStartError(
      `The agent that spawned ${child} no longer exists, so ${child} can't start.`,
    );
  const by = `@${spawner.slug}, which spawned ${child},`;
  if (spawner.archivedAt || spawner.terminatedAt || !spawner.credentialId)
    throw new AgentStartError(`${by} isn't active, so ${child} can't start.`);
  const parsed = templateConfigSchema.safeParse(spawner.config);
  if (!parsed.success)
    throw new AgentStartError(
      `The saved configuration of ${by} is invalid. Terminate it and spawn a new one.`,
    );
  let spawnerSettings: Record<string, unknown>;
  try {
    spawnerSettings = await d.workspace.readTemplateSettings(spawner.slug);
  } catch (err) {
    if (err instanceof WorkspaceError)
      throw new AgentStartError(
        `The template copy of ${by} can't be read. Terminate it and spawn a new one.`,
      );
    throw err;
  }
  let childSettings: Record<string, unknown>;
  try {
    childSettings = await d.workspace.readTemplateSettings(agent.slug);
  } catch (err) {
    if (err instanceof WorkspaceError)
      throw new AgentStartError(err.message, err.fix, err.diagnosis);
    throw err;
  }
  const grants = await d.db
    .select({
      id: schema.projects.id,
      name: schema.projects.name,
      hostPath: schema.projects.hostPath,
    })
    .from(schema.agentProjectGrants)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.agentProjectGrants.projectId))
    .where(eq(schema.agentProjectGrants.agentId, spawner.id));
  const inherited = inheritFrom(
    {
      runtime: spawner.runtime,
      permissionMode: parsed.data.permissionMode,
      credentialId: spawner.credentialId,
      grants,
      secrets: parsed.data.secrets,
      deny: readDenyRules(spawnerSettings),
    },
    config,
    readDenyRules(childSettings),
    { localRuntimeAllowed: localRuntimeAllowed(d.config) },
  );
  // A refusal is the spawn-time sentence; no fix, since editing or re-syncing a spawned agent can't lift it.
  if (!inherited.ok) throw new AgentStartError(inherited.refusal);
  return { spawner, inherited };
}

/**
 * Builds the spec for one process start. Holds the agent's workspace lock (keyed by slug)
 * around the whole thing, since Workspace methods take no lock themselves.
 * Never log the spec or its env: it carries decrypted credentials and secrets.
 */
export function createPrepareStart(d: {
  db: Db;
  config: Config;
  vault: Vault;
  workspace: Workspace;
  lock: KeyedMutex;
  /** The one ContainerManager (built in buildApp). Docker starts fail without it. */
  containers?: Pick<ContainerManager, "stopIfRunning">;
  neighborhood: Neighborhood;
  serverEnv?: NodeJS.ProcessEnv;
}): PrepareStart {
  const serverEnv = d.serverEnv ?? process.env;
  return (stale, { agentToken }) =>
    d.lock.run(stale.slug, async () => {
      const [agent] = await d.db.select().from(schema.agents).where(eq(schema.agents.id, stale.id));
      if (!agent) throw new AgentStartError(`Agent @${stale.slug} no longer exists.`);
      if (agent.archivedAt) throw new AgentArchivedError(agent.slug);
      // The local gate fails closed before anything else: no prepare, no mounts, no process (spec §13).
      if (agent.runtime === "local" && !localRuntimeAllowed(d.config))
        throw new AgentStartError(LOCAL_RUNTIME_START_MESSAGE, "runtime");
      // The jsonb column is typed, not enforced: parse the snapshot rather than trust the row type.
      const parsedConfig = templateConfigSchema.safeParse(agent.config);
      if (!parsedConfig.success) {
        const diagnosis = `The saved configuration of @${agent.slug} is invalid.`;
        throw new AgentStartError(
          `${diagnosis} Edit the agent to fix it.`,
          "edit_agent",
          diagnosis,
        );
      }
      const config = parsedConfig.data;
      const spawned = agent.kind === "ephemeral" ? await deriveInheritance(d, agent, config) : null;
      const docker = config.runtime === "docker";
      if (docker) {
        if (!d.containers)
          throw new AgentStartError("The Docker runtime isn't configured on this factory.");
        await assertCliBundle(d.config.cliBundle);
      }

      // A spawned agent runs on its spawner's current credential (§6.1), not on its own row's: syncChildren keeps the
      // two equal, and a missed path or a start racing the change can then never use a credential the spawner dropped.
      const credentialId = spawned ? spawned.inherited.credentialId : liveCredentialId(agent);
      const [cred] = await d.db
        .select()
        .from(schema.credentials)
        .where(eq(schema.credentials.id, credentialId));
      if (!cred) {
        const diagnosis = `Credential ${credentialId} no longer exists.`;
        throw new AgentStartError(
          `${diagnosis} Edit the agent and choose a credential.`,
          "edit_agent",
          diagnosis,
        );
      }
      let credentialValue: string;
      try {
        credentialValue = d.vault.open(cred.valueEnc, `credentials:${cred.id}`);
      } catch (err) {
        if (err instanceof VaultError) {
          throw new AgentStartError(
            `Can't decrypt credential ${cred.name}. Was FACTORY_SECRET_KEY changed?`,
            "credentials",
          );
        }
        throw err;
      }

      // A spawned agent's secrets are its template's ∩ its spawner's: a dropped name is never looked up (§6.3).
      const secretNames = spawned ? spawned.inherited.secrets : config.secrets;
      const secrets: Record<string, string> = {};
      for (const name of secretNames) {
        const [row] = await d.db.select().from(schema.secrets).where(eq(schema.secrets.name, name));
        if (!row) {
          throw new AgentStartError(
            `Secret ${name} isn't set. Add it in Settings → Secrets.`,
            "secrets",
          );
        }
        try {
          secrets[name] = d.vault.open(row.valueEnc, `secrets:${row.id}`);
        } catch (err) {
          if (err instanceof VaultError) {
            throw new AgentStartError(
              `Can't decrypt secret ${name}. Was FACTORY_SECRET_KEY changed?`,
              "secrets",
            );
          }
          throw err;
        }
      }

      let manager: { slug: string; displayName: string } | null = null;
      if (agent.reportsTo) {
        const [m] = await d.db
          .select({ slug: schema.agents.slug, displayName: schema.agents.displayName })
          .from(schema.agents)
          .where(eq(schema.agents.id, agent.reportsTo));
        manager = m ?? null;
      }
      const hood = await d.neighborhood.of(agent.id);
      // A spawned entry's manager is its spawner: this agent (a report) or this agent's manager (a peer).
      const slugs = new Map([[agent.id, agent.slug]]);
      if (agent.reportsTo && manager) slugs.set(agent.reportsTo, manager.slug);
      const entry = (a: AgentRow) => {
        // Every peer shares this agent's manager, so the lookup always resolves; the fallback still keeps the
        // agent-written description quoted.
        const spawnedBy =
          a.kind === "ephemeral" ? (slugs.get(a.reportsTo ?? "") ?? "unknown") : undefined;
        return {
          slug: a.slug,
          displayName: a.displayName,
          description: a.description,
          ...(spawnedBy ? { spawnedBy } : {}),
        };
      };
      const ownGrants = await d.db
        .select({ name: schema.projects.name, hostPath: schema.projects.hostPath })
        .from(schema.agentProjectGrants)
        .innerJoin(schema.projects, eq(schema.projects.id, schema.agentProjectGrants.projectId))
        .where(eq(schema.agentProjectGrants.agentId, agent.id))
        .orderBy(asc(schema.projects.name));
      // Defence in depth (§6.3): a spawned agent's grant rows narrowed to its spawner's current grants, so a missed
      // syncChildren can only narrow access, never widen it.
      const held = spawned ? new Set(spawned.inherited.grants.map((g) => g.name)) : null;
      const grants = held ? ownGrants.filter((g) => held.has(g.name)) : ownGrants;

      // Spec §10 step 2: a container left running (a missed reconciliation, a dropped exec) is stopped before any
      // host-side write, so nothing inside it races the checks and no leftover Claude runs beside the new one.
      if (docker) {
        try {
          await d.containers?.stopIfRunning(agent.id, agent.slug);
        } catch (err) {
          throw dockerStartError(err);
        }
      }

      let prepared: Awaited<ReturnType<Workspace["prepare"]>>;
      try {
        prepared = await d.workspace.prepare({
          slug: agent.slug,
          displayName: agent.displayName,
          description: agent.description,
          template: agent.template,
          config,
          manager,
          grants,
          peers: hood.peers.map(entry),
          reports: hood.reports.map(entry),
          humans: await d.neighborhood.humans(),
          kind: spawned ? "ephemeral" : "persistent",
          spawner: spawned ? { slug: spawned.spawner.slug } : null,
          spawning: maySpawn(agent)
            ? { maxLive: config.maxLiveSpawns, perHour: d.config.maxSpawnsPerHour }
            : null,
          // S9 §10.5: only persistent agents hold the schedule tools.
          scheduling: spawned
            ? null
            : {
                zone: d.config.factoryTimezone,
                maxSchedules: MAX_AGENT_SCHEDULES,
                minGapMinutes: MIN_AGENT_GAP_MINUTES,
              },
          secretNames,
          ...(spawned ? { inheritedDeny: spawned.inherited.deny } : {}),
          mcpUrl:
            config.runtime === "docker"
              ? `${d.config.agentUrl}/mcp`
              : `http://127.0.0.1:${d.config.agentPort}/mcp`,
        });
      } catch (err) {
        if (err instanceof WorkspaceError)
          throw new AgentStartError(err.message, err.fix, err.diagnosis);
        throw err;
      }

      // Docker: the checked mounts and the very context they were checked with go to ContainerManager.ensure,
      // which re-checks them right before the container create or start.
      if (docker && !prepared.mountCheck)
        throw new Error("prepare returned no mount check context for a Docker agent");

      const spec = buildRuntimeSpec({
        agentId: agent.id,
        slug: agent.slug,
        workdir: prepared.workdir,
        env: buildAgentEnv(
          serverEnv,
          {
            configDir: prepared.configDir,
            slug: agent.slug,
            credential: { kind: cred.kind, value: credentialValue },
            secrets,
            agentUrl: d.config.agentUrl,
            agentToken,
          },
          config.runtime,
        ),
        claudeBin: d.config.claudeBin,
        config,
        mounts: prepared.mounts,
      });
      return docker && prepared.mountCheck
        ? {
            ...spec,
            credentialId,
            launch: {
              image: resolveImage(config.image, d.config.defaultImage).tag,
              mountCheck: prepared.mountCheck,
            },
          }
        : { ...spec, credentialId };
    });
}
