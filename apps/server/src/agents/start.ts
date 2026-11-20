import { type AgentRow, type Db, schema } from "@open-factory/db";
import type { AgentRuntimeSpec } from "@open-factory/harness";
import { templateConfigSchema } from "@open-factory/shared";
import { asc, eq } from "drizzle-orm";
import type { Config } from "../config.ts";
import { type Vault, VaultError } from "../crypto/vault.ts";
import { WorkspaceError } from "../workspace/links.ts";
import type { KeyedMutex } from "../workspace/lock.ts";
import type { Workspace } from "../workspace/workspace.ts";
import { AgentArchivedError, AgentStartError } from "./errors.ts";
import { buildAgentEnv, buildRuntimeSpec } from "./runtime-spec.ts";

export type PrepareStart = (agent: AgentRow) => Promise<AgentRuntimeSpec>;

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
  serverEnv?: NodeJS.ProcessEnv;
}): PrepareStart {
  const serverEnv = d.serverEnv ?? process.env;
  return (stale) =>
    d.lock.run(stale.slug, async () => {
      const [agent] = await d.db.select().from(schema.agents).where(eq(schema.agents.id, stale.id));
      if (!agent) throw new AgentStartError(`Agent @${stale.slug} no longer exists.`);
      if (agent.archivedAt) throw new AgentArchivedError(agent.slug);
      // The jsonb column is typed, not enforced: parse the snapshot rather than trust the row type.
      const parsedConfig = templateConfigSchema.safeParse(agent.config);
      if (!parsedConfig.success) {
        throw new AgentStartError(
          `The saved configuration of @${agent.slug} is invalid. Edit the agent to fix it.`,
          "edit_agent",
        );
      }
      const config = parsedConfig.data;

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
      const grants = await d.db
        .select({ name: schema.projects.name, hostPath: schema.projects.hostPath })
        .from(schema.agentProjectGrants)
        .innerJoin(schema.projects, eq(schema.projects.id, schema.agentProjectGrants.projectId))
        .where(eq(schema.agentProjectGrants.agentId, agent.id))
        .orderBy(asc(schema.projects.name));

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
        });
      } catch (err) {
        if (err instanceof WorkspaceError) throw new AgentStartError(err.message, err.fix);
        throw err;
      }

      // The Docker launcher arrives in S5; prepare above still ran so the workspace is exercised.
      if (config.runtime === "docker") {
        throw new AgentStartError("The Docker runtime isn't available yet.");
      }

      return buildRuntimeSpec({
        agentId: agent.id,
        slug: agent.slug,
        workdir: prepared.workdir,
        env: buildAgentEnv(serverEnv, {
          configDir: prepared.configDir,
          slug: agent.slug,
          credential: { kind: cred.kind, value: credentialValue },
          secrets,
        }),
        claudeBin: d.config.claudeBin,
        config,
        mounts: prepared.mounts,
      });
    });
}
