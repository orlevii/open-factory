import { sendMessageToolSchema } from "@open-factory/shared";
import type { Router } from "../../messaging/router.ts";
import {
  callerOf,
  type McpServer,
  type ToolContext,
  type ToolRegistration,
  textResult,
  toolError,
  toolUseIdOf,
} from "../server.ts";

/**
 * `send_message(to[], body, urgent?)` (spec §6.1, I1 §4.4). The sender is always the token's agent; returns once the row is
 * committed and handed to the recipient, never waiting for a wake or a start.
 */
export function sendMessageTool(router: Pick<Router, "send">): ToolRegistration {
  return {
    register(server: McpServer) {
      server.registerTool(
        "send_message",
        {
          description:
            "Send a message to one or more handles (an agent's @slug or a person's @handle), up to 10. Every recipient sees the full list. Set urgent only when what a working agent is doing is now wrong: it stops the agent's current tool and turn.",
          inputSchema: sendMessageToolSchema,
        },
        async (args: { to: string[]; body: string; urgent?: boolean }, tctx: ToolContext) => {
          const { results } = await router.send(
            { agentId: callerOf(tctx), toolUseId: toolUseIdOf(tctx) },
            args.to,
            args.body,
            args.urgent ?? false,
          );
          if (results.every((r) => r.status === "refused"))
            return toolError(
              results.map((r) => (r.status === "refused" ? r.reason : "")).join("\n"),
            );
          return textResult({ results });
        },
      );
    },
  };
}
