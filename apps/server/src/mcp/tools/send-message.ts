import { sendMessageToolSchema } from "@open-factory/shared";
import type { EventStore } from "../../agents/event-store.ts";
import type { Router } from "../../messaging/router.ts";
import { UnknownTagsError } from "../../principals/principal-text.ts";
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
export function sendMessageTool(
  router: Pick<Router, "send">,
  store: Pick<EventStore, "facing">,
): ToolRegistration {
  return {
    register(server: McpServer) {
      server.registerTool(
        "send_message",
        {
          description:
            "Send a message to one or more agents or people, up to 10, each as their tag <@ref|handle>, ref, or @handle. Every recipient sees the full list. This is how you answer a message: your text output doesn't reach its sender. Set urgent only when what a working agent is doing is now wrong: it stops the agent's current tool and turn.",
          inputSchema: sendMessageToolSchema,
        },
        async (args: { to: string[]; body: string; urgent?: boolean }, tctx: ToolContext) => {
          let sent: Awaited<ReturnType<typeof router.send>>;
          try {
            sent = await router.send(
              { agentId: callerOf(tctx), toolUseId: toolUseIdOf(tctx) },
              args.to,
              args.body,
              args.urgent ?? false,
            );
          } catch (e) {
            if (e instanceof UnknownTagsError) return toolError(e.message);
            throw e;
          }
          const { results, warnings } = sent;
          if (results.every((r) => r.status === "refused"))
            return toolError(
              results.map((r) => (r.status === "refused" ? r.reason : "")).join("\n"),
            );
          // Each recipient reads back as its tag, so the result can be passed on as written.
          const delivered = results.filter((r) => r.status !== "refused");
          const facing = await store.facing({ handles: delivered.map((r) => r.to) });
          return textResult({
            results: results.map((r) =>
              r.status === "refused" ? r : { ...r, to: facing.tag(r.to) },
            ),
            ...(warnings.length ? { warnings } : {}),
          });
        },
      );
    },
  };
}
