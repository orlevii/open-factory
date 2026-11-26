import { type AgentStatus, spawnAgentToolSchema } from "@open-factory/shared";
import {
  callerOf,
  type McpServer,
  type ToolContext,
  type ToolRegistration,
  textResult,
  toolError,
  toolUseIdOf,
} from "../server.ts";

export type SpawnArgs = { template: string; suffix?: string; description: string; prompt: string };
export type SpawnResult =
  | {
      ok: true;
      slug: string;
      /** The new agent as `<@ref|handle>`. */
      tag: string;
      agentId: string;
      status: AgentStatus;
      note?: string;
      warnings?: string[];
    }
  | { ok: false; message: string };
export interface SpawnPort {
  spawn(callerId: string, args: SpawnArgs, toolUseId: string | null): Promise<SpawnResult>;
}

/** `spawn_agent` (spec §7.1). Registered only for a caller that `maySpawn`; the template enum is its allowlist. */
export function spawnAgentTool(d: {
  spawn: SpawnPort;
  templates: [string, ...string[]];
}): ToolRegistration {
  return {
    register(server: McpServer) {
      server.registerTool(
        "spawn_agent",
        {
          description:
            "Spawn a fresh agent from one of your templates for one phase of work. Returns at once: the agent reports to you, its text reaches you as updates, and you can message it. Its first message is your prompt, so make the brief complete and name, by tag, the collaborators it will work with.",
          inputSchema: spawnAgentToolSchema(d.templates),
        },
        async (args: SpawnArgs, tctx: ToolContext) => {
          const r = await d.spawn.spawn(callerOf(tctx), args, toolUseIdOf(tctx));
          if (!r.ok) return toolError(r.message);
          return textResult({
            slug: r.slug,
            tag: r.tag,
            agent_id: r.agentId,
            status: r.status,
            ...(r.note ? { note: r.note } : {}),
            ...(r.warnings?.length ? { warnings: r.warnings } : {}),
          });
        },
      );
    },
  };
}
