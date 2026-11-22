import type { OpenTurnRows, ToolRow } from "./rows";

/** What the agent is doing now (U3 §5.1): data only; `ActivityLine` formats it. */
export type ActivityKind =
  | "tool_input"
  | "tool"
  | "subagent"
  | "subagents"
  | "thinking"
  | "text"
  | "working"
  | "compacting";
export type Activity = {
  kind: ActivityKind;
  tool?: string;
  target?: string;
  more?: number;
  /** The target is the agent's own words (a Bash `description`): it reads as prose, with no verb. */
  prose?: true;
};

/** The live state's parts the activity reads (PR4's `LiveState` satisfies it; PR1 passes nothing). */
export type ActivityLive = {
  /** `target` is the raw file path, command or pattern the harness parsed early (U3 §11.1). */
  toolInput?: { toolUseId?: string; name: string; target?: string; bytes?: number };
  thinking?: { tokens: number };
  texts: readonly unknown[];
};

export const WORKING: Activity = { kind: "working" };
/** A compaction is running: it isn't a tool call or a reply, and it can't be interrupted (D5). */
export const COMPACTING: Activity = { kind: "compacting" };

const FILE_TOOLS = new Set(["Read", "Edit", "MultiEdit", "Write", "NotebookEdit"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob"]);

const firstLine = (s: string) => s.split("\n", 1)[0]?.trim() || undefined;
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1) || undefined;

/** An MCP tool's name in parts (`mcp__server__tool`), shared by the activity line and the tool row so
 *  both read "server · tool" and truncate the server first (`McpName`). Undefined for other tools. */
export function mcpParts(tool: string): { server: string; tool?: string } | undefined {
  if (!tool.startsWith("mcp__")) return undefined;
  const [server = "", ...rest] = tool.slice(5).split("__");
  return rest.length > 0 ? { server, tool: rest.join("__") } : { server };
}

/** The short target of a tool call, shared by the open tool and PR4's live tool input: Bash's
 *  `description` else the command's first line, a file tool's file name, a search's pattern, and an
 *  MCP tool's "server · tool". Undefined when the tool has none of these. */
export function formatTarget(tool: string, input: unknown): string | undefined {
  const mcp = mcpParts(tool);
  if (mcp) return mcp.tool === undefined ? mcp.server : `${mcp.server} · ${mcp.tool}`;
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : undefined);
  if (tool === "Bash") {
    const d = str("description");
    return (d && firstLine(d)) ?? firstLine(str("command") ?? "");
  }
  if (FILE_TOOLS.has(tool)) {
    const p = str("file_path") ?? str("notebook_path") ?? str("path");
    return p ? baseName(p) : undefined;
  }
  if (SEARCH_TOOLS.has(tool)) return firstLine(str("pattern") ?? "");
  return undefined;
}

/** A Bash call the agent described: its description already says what it does ("Run the tests"). */
const described = (r: ToolRow) => {
  const d = (r.call.input as Record<string, unknown> | null)?.description;
  return r.call.name === "Bash" && typeof d === "string" && !!d.trim();
};

const subagentName = (r: ToolRow) => {
  const d = (r.call.input as Record<string, unknown> | null)?.description;
  return typeof d === "string" && d.trim() ? firstLine(d) : r.call.name;
};

/** The first that applies: live tool input, open subagents, the newest open tool, thinking, live
 *  text, else "Working" (U3 §5.1). */
export function deriveActivity(
  open: OpenTurnRows | undefined,
  live: ActivityLive | undefined,
): Activity {
  if (live?.toolInput) {
    const { name, target: raw } = live.toolInput;
    // The raw target through the open tool's formatter: the label stays put when the call lands.
    const target =
      raw === undefined
        ? undefined
        : formatTarget(name, { file_path: raw, command: raw, pattern: raw });
    return target === undefined
      ? { kind: "tool_input", tool: name }
      : { kind: "tool_input", tool: name, target };
  }
  const subs = open?.openSubagents ?? [];
  const newest = subs.at(-1);
  if (newest) {
    const target = subagentName(newest);
    return subs.length === 1
      ? { kind: "subagent", target }
      : { kind: "subagents", target, more: subs.length - 1 };
  }
  const tool = open?.newestOpenTool;
  if (tool) {
    const target = formatTarget(tool.call.name, tool.call.input);
    if (target === undefined) return { kind: "tool", tool: tool.call.name };
    return described(tool)
      ? { kind: "tool", tool: tool.call.name, target, prose: true }
      : { kind: "tool", tool: tool.call.name, target };
  }
  if (live?.thinking) return { kind: "thinking" };
  if (live && live.texts.length > 0) return { kind: "text" };
  return WORKING;
}

/** A primitive per distinct activity, for memo and hold keys. */
export const activityKey = (a: Activity) =>
  `${a.kind}:${a.tool ?? ""}:${a.target ?? ""}:${a.more ?? ""}:${a.prose ? "p" : ""}`;
