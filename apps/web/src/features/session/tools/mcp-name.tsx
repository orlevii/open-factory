import { mcpParts } from "../activity";

/** The characters a long server keeps at the narrowest (its ellipses included). */
const SERVER_MIN = 8;

/** A name split in half by characters (never inside a surrogate pair): the head shrinks first. */
function halves(s: string): [string, string] {
  const chars = Array.from(s);
  const mid = Math.ceil(chars.length / 2);
  return [chars.slice(0, mid).join(""), chars.slice(mid).join("")];
}

/** "server · tool" for an MCP tool name (spec §9.2): the server middle-truncates (its head shrinks
 *  to an ellipsis, then its tail ends in one) down to 8 characters, and the tool keeps its tail,
 *  cutting from its start only once the server is at that minimum. Any other name renders as itself, end-truncating. Shared by the tool row
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
  // A long server gives way first (shrink 100 to the tool's 1) but never below 8 characters, so it
  // never collapses to nothing; a shorter one never shrinks.
  const long = Array.from(mcp.server).length > SERVER_MIN;
  return (
    <span title={title} className={`flex min-w-0 ${className}`}>
      <span
        data-mcp-server
        className={`flex overflow-hidden whitespace-pre ${long ? "min-w-[8ch] shrink-[100]" : "shrink-0"}`}
      >
        {/* The head shrinks to its ellipsis first; then the tail ends in one. */}
        <span className="min-w-[1ch] shrink-[100] truncate">{head}</span>
        <span className="min-w-0 truncate">{tail}</span>
      </span>
      {mcp.tool !== undefined && (
        // A right-to-left box puts the ellipsis at the start; the text inside stays left-to-right.
        <span data-mcp-tool dir="rtl" className="min-w-0 truncate text-left whitespace-pre">
          <span dir="ltr"> · {mcp.tool}</span>
        </span>
      )}
    </span>
  );
}
