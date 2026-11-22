import { mcpParts } from "../activity";

/** "server · tool" for an MCP tool name (spec §9.2): the server truncates first, the tool keeps
 *  its head until the server is gone. Any other name renders as itself, end-truncating. Shared by
 *  the tool row and the activity line. */
export function McpName({
  name,
  className = "",
  title,
}: {
  name: string;
  className?: string;
  title?: string;
}) {
  const mcp = mcpParts(name);
  if (!mcp)
    return (
      <span title={title} className={`min-w-0 truncate ${className}`}>
        {name}
      </span>
    );
  return (
    <span title={title} className={`flex min-w-0 ${className}`}>
      <span className="min-w-0 truncate">{mcp.server}</span>
      {mcp.tool !== undefined && (
        <span className="max-w-full shrink-0 truncate whitespace-pre"> · {mcp.tool}</span>
      )}
    </span>
  );
}
