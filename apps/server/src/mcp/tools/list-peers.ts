import type { AgentRow } from "@open-factory/db";
import { type AgentStatus, listPeersToolSchema } from "@open-factory/shared";
import type { Neighborhood } from "../../messaging/neighborhood.ts";
import {
  callerOf,
  type McpServer,
  type ToolContext,
  type ToolRegistration,
  textResult,
} from "../server.ts";

type Relation = "manager" | "peer" | "report" | "other";

export function listPeersTool(d: {
  neighborhood: Neighborhood;
  statusOf(agentId: string): AgentStatus;
}): ToolRegistration {
  return {
    register(server: McpServer) {
      server.registerTool(
        "list_peers",
        {
          description:
            'List the agents you can message (your manager, peers and reports) and the humans. Pass scope "all" to see every agent.',
          inputSchema: listPeersToolSchema,
        },
        async (args: { scope?: "neighborhood" | "all" }, tctx: ToolContext) => {
          const me = callerOf(tctx);
          const n = await d.neighborhood.of(me);
          const rows: [Relation, AgentRow][] = [
            ...(n.manager ? [["manager", n.manager] as [Relation, AgentRow]] : []),
            ...n.peers.map((a): [Relation, AgentRow] => ["peer", a]),
            ...n.reports.map((a): [Relation, AgentRow] => ["report", a]),
          ];
          if (args.scope === "all") {
            const seen = new Set([me, ...rows.map(([, a]) => a.id)]);
            for (const a of await d.neighborhood.all()) {
              if (!seen.has(a.id)) rows.push(["other", a]);
            }
          }
          return textResult({
            agents: rows.map(([relation, a]) => ({
              slug: a.slug,
              displayName: a.displayName,
              description: a.description,
              relation,
              status: d.statusOf(a.id),
            })),
            humans: await d.neighborhood.humans(),
          });
        },
      );
    },
  };
}
