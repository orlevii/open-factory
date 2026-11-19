// S6 adds the "factory" server here.
export function buildMcpJson(tplMcp: { mcpServers: Record<string, unknown> }): {
  mcpServers: Record<string, unknown>;
} {
  return { mcpServers: { ...tplMcp.mcpServers } };
}
