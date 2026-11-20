import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";

export type { McpServer };

/** A tool bound to the calling agent. Handlers re-read the caller from `tctx.http.authInfo.clientId`. */
export interface ToolRegistration {
  register(server: McpServer): void;
}

/** What a tool handler's second argument carries (verified live in S6 Task 1). */
export interface ToolContext {
  http?: { authInfo?: { clientId?: string } };
  mcpReq?: { _meta?: Record<string, unknown> };
}

export function callerOf(tctx: ToolContext): string {
  const id = tctx.http?.authInfo?.clientId;
  if (!id) throw new Error("factory MCP called without an authenticated agent");
  return id;
}

export function toolUseIdOf(tctx: ToolContext): string | null {
  const v = tctx.mcpReq?._meta?.["claudecode/toolUseId"];
  return typeof v === "string" && /^toolu_[A-Za-z0-9]{1,120}$/.test(v) ? v : null;
}

export function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

export function toolError(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

/**
 * The stateless factory MCP server (spec §6). Matches the listener's `mcp(req, agentId)` contract: the
 * listener has already authenticated the token, and the agent id reaches handlers as `authInfo.clientId`.
 */
export function createFactoryMcp(d: {
  tools: ToolRegistration[];
  version: string;
  onerror(err: Error): void;
}) {
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({ name: "factory", version: d.version });
      for (const t of d.tools) t.register(server);
      return server;
    },
    {
      legacy: "stateless",
      responseMode: "json",
      maxRequestBodySize: 512 * 1024,
      onerror: d.onerror,
    },
  );
  return (req: Request, agentId: string): Promise<Response> =>
    handler.fetch(req, { authInfo: { token: "-", clientId: agentId, scopes: [] } });
}
