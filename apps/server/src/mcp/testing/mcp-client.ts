let id = 0;

/** One JSON-RPC call to an agent listener's `/mcp`, as Claude's MCP client sends it (stateless, JSON response). */
export async function mcpCall(url: string, token: string, method: string, params: object) {
  id += 1;
  const res = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (res.status !== 200) return { status: res.status, json: undefined };
  // The SDK answers a single request as JSON or as one SSE `message` event, depending on the negotiation.
  const raw = await res.text();
  const data = raw.startsWith("event:")
    ? (raw.split("\n").find((l) => l.startsWith("data:")) ?? "").slice(5)
    : raw;
  // biome-ignore lint/suspicious/noExplicitAny: a JSON-RPC envelope, read by tests only
  const json: any = JSON.parse(data);
  return { status: res.status, json };
}

/** `tools/call`, with Claude's `_meta` tool-use id when given; returns the tool result. */
export async function callTool(
  url: string,
  token: string,
  name: string,
  args: object,
  toolUseId?: string,
) {
  const r = await mcpCall(url, token, "tools/call", {
    name,
    arguments: args,
    ...(toolUseId ? { _meta: { "claudecode/toolUseId": toolUseId } } : {}),
  });
  if (r.status !== 200) throw new Error(`tools/call ${name} → ${r.status}`);
  return r.json.result as { content: { type: string; text: string }[]; isError?: boolean };
}
