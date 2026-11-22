import { mcpParts } from "../activity";

/** A name split in half by characters (never inside a surrogate pair): the head shrinks first. */
function halves(s: string): [string, string] {
  const chars = Array.from(s);
  const mid = Math.ceil(chars.length / 2);
  return [chars.slice(0, mid).join(""), chars.slice(mid).join("")];
}

/** "server · tool" for an MCP tool name (spec §9.2): the server middle-truncates (its head shrinks
 *  with an ellipsis, then its tail clips), and the tool keeps its tail, cutting from its start only
 *  once the server is gone. Any other name renders as itself, end-truncating. Shared by the tool row
 *  and the activity line. */
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
  const [head, tail] = halves(mcp.server);
  return (
    <span title={title} className={`flex min-w-0 ${className}`}>
      <span data-mcp-server className="flex min-w-0 overflow-hidden whitespace-pre">
        <span className="min-w-0 truncate">{head}</span>
        <span className="shrink-0">{tail}</span>
      </span>
      {mcp.tool !== undefined && (
        // A right-to-left box puts the ellipsis at the start; the text inside stays left-to-right.
        <span
          data-mcp-tool
          dir="rtl"
          className="max-w-full shrink-0 truncate text-left whitespace-pre"
        >
          <span dir="ltr"> · {mcp.tool}</span>
        </span>
      )}
    </span>
  );
}
