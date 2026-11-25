import type { AgentRow } from "@open-factory/db";
import { type AgentStatus, listPeersToolSchema } from "@open-factory/shared";
import { inline } from "../../messaging/inline.ts";
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
  /** The live status (a loaded runtime) or what the row says. */
  statusOf(agent: AgentRow): AgentStatus;
}): ToolRegistration {
  return {
    register(server: McpServer) {
      server.registerTool(
        "list_peers",
        {
          description:
            'List who you can message: agents (your manager, peers and reports) and humans, each with a handle. Pass scope "all" to see every agent.',
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
          const humans = await d.neighborhood.humans();
          return textResult({
            peers: [
              ...rows.map(([relation, a]) => ({
                handle: `@${a.slug}`,
                kind: "agent" as const,
                displayName: inline(a.displayName),
                description: inline(a.description),
                relation,
                status: d.statusOf(a),
              })),
              ...humans.map((h) => ({
                handle: `@${h.handle}`,
                kind: "human" as const,
                name: inline(h.name),
              })),
            ],
          });
        },
      );
    },
  };
}
