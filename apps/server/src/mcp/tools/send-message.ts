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
 * `send_message(to, body, urgent?)` (spec §6.1). The sender is always the token's agent; returns once the row is
 * committed and handed to the recipient, never waiting for a wake or a start.
 */
export function sendMessageTool(router: Pick<Router, "send">): ToolRegistration {
  return {
    register(server: McpServer) {
      server.registerTool(
        "send_message",
        {
          description:
            'Send a message to another agent (by slug) or a human (by handle; "@humans" reaches every human). Set urgent to interrupt an agent that is working.',
          inputSchema: sendMessageToolSchema,
        },
        async (args: { to: string; body: string; urgent?: boolean }, tctx: ToolContext) => {
          const r = await router.send(
            { agentId: callerOf(tctx), toolUseId: toolUseIdOf(tctx) },
            args.to,
            args.body,
            args.urgent ?? false,
          );
          if (!r.ok) return toolError(r.message);
          return textResult({
            id: r.id,
            to: r.to,
            status: r.status,
            ...(r.note ? { note: r.note } : {}),
          });
        },
      );
    },
  };
}
