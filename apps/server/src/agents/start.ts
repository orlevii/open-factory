import { stat } from "node:fs/promises";
import { type AgentRow, type Db, schema } from "@open-factory/db";
import type { AgentRuntimeSpec } from "@open-factory/harness";
import { templateConfigSchema } from "@open-factory/shared";
import { asc, eq } from "drizzle-orm";
import { type Config, LOCAL_RUNTIME_START_MESSAGE, localRuntimeAllowed } from "../config.ts";
import { type Vault, VaultError } from "../crypto/vault.ts";
import type { Neighborhood } from "../messaging/neighborhood.ts";
import type { ContainerManager } from "../runtime/docker/containers.ts";
import { dockerStartError } from "../runtime/docker/errors.ts";
import { WorkspaceError } from "../workspace/links.ts";
import type { KeyedMutex } from "../workspace/lock.ts";
import type { MountCheckContext } from "../workspace/mounts.ts";
import type { Workspace } from "../workspace/workspace.ts";
import { AgentArchivedError, AgentStartError } from "./errors.ts";
import { buildAgentEnv, buildRuntimeSpec } from "./runtime-spec.ts";

/**
 * What a Docker start still has to do outside the workspace lock (spec §10 step 4): `ContainerManager.ensure` with the
 * image and the same mount-check context `prepare` checked the mounts with.
 */
export interface DockerLaunch {
  image: string;
  mountCheck: MountCheckContext;
}

/** The spec of one start; a Docker start also carries its `launch` (never passed to the driver). */
export type PreparedSpec = AgentRuntimeSpec & { launch?: DockerLaunch };

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
        throw new AgentStartError(
          `The saved configuration of @${agent.slug} is invalid. Edit the agent to fix it.`,
          "edit_agent",
        );
      }
      const config = parsedConfig.data;
      const docker = config.runtime === "docker";
      if (docker) {
        if (!d.containers)
          throw new AgentStartError("The Docker runtime isn't configured on this factory.");
        await assertCliBundle(d.config.cliBundle);
      }

      const [cred] = await d.db
        .select()
        .from(schema.credentials)
        .where(eq(schema.credentials.id, agent.credentialId));
      if (!cred) {
        throw new AgentStartError(
          `Credential ${agent.credentialId} no longer exists. Edit the agent and choose a credential.`,
          "edit_agent",
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

      const secrets: Record<string, string> = {};
      for (const name of config.secrets) {
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
      const entry = (a: AgentRow) => ({
        slug: a.slug,
        displayName: a.displayName,
        description: a.description,
      });
      const grants = await d.db
        .select({ name: schema.projects.name, hostPath: schema.projects.hostPath })
        .from(schema.agentProjectGrants)
        .innerJoin(schema.projects, eq(schema.projects.id, schema.agentProjectGrants.projectId))
        .where(eq(schema.agentProjectGrants.agentId, agent.id))
        .orderBy(asc(schema.projects.name));

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
          mcpUrl:
            config.runtime === "docker"
              ? `${d.config.agentUrl}/mcp`
              : `http://127.0.0.1:${d.config.agentPort}/mcp`,
        });
      } catch (err) {
        if (err instanceof WorkspaceError) throw new AgentStartError(err.message, err.fix);
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
            launch: {
              image: config.image ?? d.config.defaultImage,
              mountCheck: prepared.mountCheck,
            },
          }
        : spec;
    });
}
