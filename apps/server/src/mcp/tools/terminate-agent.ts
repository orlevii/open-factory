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
    targetArg: string,
  ): Promise<
    { ok: true; handle: string; tag: string; warning?: string } | { ok: false; message: string }
  >;
}

/** `terminate_agent` (spec §7.1). Registered only for a caller that `maySpawn`; the port checks the target is its child. */
export function terminateAgentTool(d: { terminate: TerminatePort }): ToolRegistration {
  return {
    register(server: McpServer) {
      server.registerTool(
        "terminate_agent",
        {
          description:
            "Terminate an agent you spawned when its work is done. Its process stops now and its session can't continue, and its working directory is deleted 3 days later, so first ask it to put anything worth keeping in a granted project or a message.",
          inputSchema: terminateAgentToolSchema,
        },
        async (args: { target: string }, tctx: ToolContext) => {
          const r = await d.terminate.terminateChild(callerOf(tctx), args.target);
          if (!r.ok) return toolError(r.message);
          return textResult({
            handle: r.handle,
            tag: r.tag,
            status: "terminated",
            ...(r.warning ? { warnings: [r.warning] } : {}),
          });
        },
      );
    },
  };
}
