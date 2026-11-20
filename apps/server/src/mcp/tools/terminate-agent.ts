import { terminateAgentToolSchema } from "@open-factory/shared";
import {
  callerOf,
  type McpServer,
  type ToolContext,
  type ToolRegistration,
  textResult,
  toolError,
} from "../server.ts";

export interface TerminatePort {
  terminateChild(
    callerId: string,
    slugArg: string,
  ): Promise<{ ok: true; slug: string } | { ok: false; message: string }>;
}

/** `terminate_agent` (spec §7.1). Registered only for a caller that `maySpawn`; the port checks the target is its child. */
export function terminateAgentTool(d: { terminate: TerminatePort }): ToolRegistration {
  return {
    register(server: McpServer) {
      server.registerTool(
        "terminate_agent",
        {
          description:
            "Terminate an agent you spawned. Its process stops now and its session can't continue.",
          inputSchema: terminateAgentToolSchema,
        },
        async (args: { slug: string }, tctx: ToolContext) => {
          const r = await d.terminate.terminateChild(callerOf(tctx), args.slug);
          if (!r.ok) return toolError(r.message);
          return textResult({ slug: r.slug, status: "terminated" });
        },
      );
    },
  };
}
