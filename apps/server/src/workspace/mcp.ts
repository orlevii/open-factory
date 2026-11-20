/** The `factory` server's header keeps the literal placeholder: Claude expands it from the process env (no secret on disk). */
export function buildMcpJson(
  tplMcp: { mcpServers: Record<string, unknown> },
  factory: { url: string },
): {
  mcpServers: Record<string, unknown>;
} {
  return {
    mcpServers: {
      ...tplMcp.mcpServers,
      factory: {
        type: "http",
        url: factory.url,
        headers: { Authorization: "Bearer ${OPEN_FACTORY_AGENT_TOKEN}" },
      },
    },
  };
}
