import { type AgentStatus, listPeersToolSchema } from "@open-factory/shared";
import { agentTagOf, renderTags } from "@open-factory/shared/tags";
import { inline } from "../../messaging/inline.ts";
import type { Neighborhood } from "../../messaging/neighborhood.ts";
import type { AgentRecord } from "../../principals/principal-store.ts";
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
  statusOf(agent: AgentRecord): AgentStatus;
}): ToolRegistration {
  return {
    register(server: McpServer) {
      server.registerTool(
        "list_peers",
        {
          description:
            'List who you can message: agents (your manager, peers and reports) and humans, each with a handle and a tag to write them as. Pass scope "all" to see every agent.',
          inputSchema: listPeersToolSchema,
        },
        async (args: { scope?: "neighborhood" | "all" }, tctx: ToolContext) => {
          const me = callerOf(tctx);
          const n = await d.neighborhood.of(me);
          const rows: [Relation, AgentRecord][] = [
            ...(n.manager ? [["manager", n.manager] as [Relation, AgentRecord]] : []),
            ...n.peers.map((a): [Relation, AgentRecord] => ["peer", a]),
            ...n.reports.map((a): [Relation, AgentRecord] => ["report", a]),
          ];
          if (args.scope === "all") {
            const seen = new Set([me, ...rows.map(([, a]) => a.id)]);
            for (const a of await d.neighborhood.all()) {
              if (!seen.has(a.id)) rows.push(["other", a]);
            }
          }
          const humans = await d.neighborhood.humans();
          const principals = await d.neighborhood.principalsOf(rows.map(([, a]) => a.id));
          const listed = rows.map(([relation, a]) => {
            const p = principals.get(a.id);
            if (!p) throw new Error(`No principal ${a.id}`);
            return { relation, a, p };
          });
          const lookup = await d.neighborhood.tagLookup(listed.map(({ a }) => a.description));
          return textResult({
            peers: [
              ...listed.map(({ relation, a, p }) => ({
                handle: `@${p.handle}`,
                tag: agentTagOf(p),
                kind: "agent" as const,
                displayName: inline(a.displayName),
                description: inline(renderTags(a.description, lookup, "agent")),
                relation,
                status: d.statusOf(a),
              })),
              ...humans.map((h) => ({
                handle: `@${h.handle}`,
                tag: agentTagOf(h),
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
