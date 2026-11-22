import { mcpParts } from "../activity";

/** The server's last characters, which always stay (its head shrinks instead). */
const TAIL_KEEP = 6;
/** The head's least width in characters: 3 of its own and the ellipsis (below that a lone "g…"
 *  reads like a name). A head no longer than this never shrinks. */
const HEAD_MIN = 4;

/** A server split into a head that shrinks and its last few characters, which stay (never inside a
 *  surrogate pair). */
function split(s: string): [string, string] {
  const chars = Array.from(s);
  const keep = Math.min(TAIL_KEEP, Math.floor(chars.length / 2));
  return [chars.slice(0, chars.length - keep).join(""), chars.slice(chars.length - keep).join("")];
}

/** "server · tool" for an MCP tool name (spec §9.2). The server middle-truncates: its head shrinks
 *  first (shrink 100 to the tool's 1), down to 3 characters and an ellipsis, while its last 6 stay.
 *  Only then does the tool shrink, from its start, so it keeps its tail. " · " sits between them,
 *  outside both truncations, so it always shows. Any other name renders as itself, end-truncating.
 *  Shared by the tool row and the activity line. */
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
  const [head, tail] = split(mcp.server);
  const shrinks = Array.from(head).length > HEAD_MIN;
  // An intrinsic minimum would be the whole text (truncation doesn't lower it), so the least widths
  // are explicit: the head's 4 characters (3 and the ellipsis), and the server's that plus the tail.
  // The name is set in mono, where a `ch` is a character; the extra pixel absorbs rounding, which
  // otherwise drops a character before the ellipsis.
  const headLeast = { minWidth: `calc(${HEAD_MIN}ch + 1px)` };
  const least = { minWidth: `calc(${HEAD_MIN + Array.from(tail).length}ch + 1px)` };
  return (
    <span title={title} className={`flex min-w-0 ${className}`}>
      <span
        data-mcp-server
        style={shrinks ? least : undefined}
        className={`flex overflow-hidden whitespace-pre ${shrinks ? "shrink-[100]" : "shrink-0"}`}
      >
        <span data-mcp-head {...(shrinks ? { style: headLeast, className: "truncate" } : {})}>
          {head}
        </span>
        <span className="shrink-0">{tail}</span>
      </span>
      {mcp.tool !== undefined && (
        <>
          <span data-mcp-sep className="shrink-0 whitespace-pre">
            {" · "}
          </span>
          {/* A right-to-left box puts the ellipsis at the start; the text inside stays left-to-right. */}
          <span data-mcp-tool dir="rtl" className="min-w-0 truncate text-left whitespace-pre">
            <span dir="ltr">{mcp.tool}</span>
          </span>
        </>
      )}
    </span>
  );
}
