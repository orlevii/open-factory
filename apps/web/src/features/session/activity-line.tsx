import { memo, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Elapsed } from "@/components/elapsed";
import { MiddleTruncate } from "@/components/middle-truncate";
import {
  type Activity,
  type ActivityLive,
  activityKey,
  COMPACTING,
  deriveActivity,
  formatTarget,
  mcpParts,
  WORKING,
} from "./activity";
import { formatBytes } from "./format";
import type { OpenTurnRows } from "./rows";
import { ROW_GUTTER } from "./timeline-item";
import { McpName } from "./tools/mcp-name";
import { useSampled } from "./use-sampled";

const VERB: Partial<Record<string, string>> = {
  Bash: "Running",
  Read: "Reading",
  Edit: "Editing",
  MultiEdit: "Editing",
  NotebookEdit: "Editing",
  Write: "Writing",
  Grep: "Searching",
  Glob: "Searching",
};
/** "Reading `retry.ts`": a tool's verb and its formatted target, else the target or the tool's name
 *  (shared with the subagent card's live line, U3 §12). `code` is the part shown as code. */
export function toolPhrase(
  tool: string,
  target: string | undefined,
): { verb?: string; code: string } {
  const verb = VERB[tool];
  return verb && target ? { verb, code: target } : { code: target ?? tool };
}

const PLAIN: Partial<Record<Activity["kind"], string>> = {
  thinking: "Thinking",
  text: "Writing a reply",
  working: "Working",
  compacting: "Compacting",
};

/** Tools whose target is a file path: only these middle-truncate (keeping the file name). */
const PATH_TOOLS = new Set(["Read", "Edit", "MultiEdit", "NotebookEdit", "Write"]);

/** The label in parts: a fixed prefix, a truncating target (code for tools; a path middle-truncates,
 *  anything else, a command or a description, end-truncates) and a fixed suffix. */
function labelParts(a: Activity): {
  prefix?: string;
  target?: string;
  code?: boolean;
  path?: boolean;
  /** An MCP tool's full name: the target renders as `McpName` (the tool row's truncation). */
  mcp?: string;
  suffix?: string;
} {
  const plain = PLAIN[a.kind];
  if (plain) return { prefix: plain };
  if (a.kind === "subagent") return { prefix: "Subagent: ", target: a.target };
  if (a.kind === "subagents")
    return { prefix: "Subagents: ", target: a.target, suffix: ` and ${a.more} more` };
  // "Run the tests", not "Running Run the tests" in code.
  if (a.prose && a.target) return { target: a.target };
  const tool = a.tool ?? "";
  const verb = VERB[tool];
  if (verb && a.target)
    return { prefix: `${verb} `, target: a.target, code: true, path: PATH_TOOLS.has(tool) };
  // An MCP tool reads "server · tool", the server truncating first; any other tool its name.
  if (mcpParts(tool)) return { target: a.target ?? tool, code: true, mcp: tool };
  return { target: a.target ?? tool, code: true };
}

/** "[tooth] 42s · Running `pnpm test`" (U3 §5.2): the duration first so it never moves sideways; the
 *  label takes the rest, truncating, with the whole label on hover. Fades in once on mount. */
export const ActivityLine = memo(function ActivityLine({
  activity,
  startedAt,
  count,
  live = false,
}: {
  activity: Activity;
  startedAt?: string;
  /** The line appeared by a live frame: it fades in once. Decided at mount, never toggled after. */
  live?: boolean;
  /** A fast counter after the label ("12 KB" of tool input), sampled by its own component. */
  count?: ReactNode;
}) {
  const { prefix, target, code, path, mcp, suffix } = labelParts(activity);
  const full = `${prefix ?? ""}${target ?? ""}${suffix ?? ""}`;
  const [fades] = useState(live);
  return (
    <p
      data-activity-line
      {...(fades ? { "data-live": "" } : {})}
      className={`flex h-6 min-w-0 items-center ${ROW_GUTTER} text-[0.8125rem] leading-[1.125rem] text-muted-foreground`}
    >
      <span
        aria-hidden="true"
        className="mr-2 inline-flex size-3 shrink-0 items-center justify-center"
      >
        <span className="of-tooth" />
      </span>
      {startedAt !== undefined && (
        <>
          <Elapsed since={startedAt} />
          <span className="shrink-0 whitespace-pre"> · </span>
        </>
      )}
      <span data-activity-label title={full} className="flex min-w-0 items-baseline">
        {prefix !== undefined && <span className="shrink-0 whitespace-pre">{prefix}</span>}
        {target !== undefined &&
          (mcp !== undefined ? (
            <McpName name={mcp} className="font-mono" />
          ) : path ? (
            <span className={`flex min-w-0 ${code ? "font-mono" : ""}`}>
              <MiddleTruncate text={target} />
            </span>
          ) : (
            <span className={`min-w-0 truncate ${code ? "font-mono" : ""}`}>{target}</span>
          ))}
        {suffix !== undefined && <span className="shrink-0 whitespace-pre">{suffix}</span>}
      </span>
      {count}
    </p>
  );
});

/** `deriveActivity`, memoized on primitive inputs only; an equal result keeps the previous object
 *  (U3 §5.2, M4). */
export function useActivity(
  open: OpenTurnRows | undefined,
  live: ActivityLive | undefined,
): Activity {
  const tool = open?.newestOpenTool;
  const toolKey = tool?.key;
  const toolTarget = tool ? formatTarget(tool.call.name, tool.call.input) : undefined;
  const subagentKeys = open?.openSubagents.map((r) => r.key).join(",") ?? "";
  const inputName = live?.toolInput?.name;
  const inputTarget = live?.toolInput?.target;
  const thinking = !!live?.thinking;
  const texts = live?.texts.length ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the primitives that decide the result; the objects behind an unchanged key give the same activity
  const next = useMemo(
    () => deriveActivity(open, live),
    [toolKey, toolTarget, subagentKeys, inputName, inputTarget, thinking, texts],
  );
  const prev = useRef(next);
  // Safe in render: the ref only holds the last committed value, and the choice is pure.
  const value = activityKey(prev.current) === activityKey(next) ? prev.current : next;
  useLayoutEffect(() => {
    prev.current = value;
  }, [value]);
  return value;
}

const HOLD_MS = 400;

/** Label swaps are instant, except a change to the fallback "Working", which keeps the previous
 *  label for 400ms (Q41). A new `turnKey` never inherits a held label. */
export function useFallbackHold(activity: Activity, turnKey: string | undefined): Activity {
  const key = activityKey(activity);
  const [s, setS] = useState({ turnKey, key, shown: activity, holding: false });
  let cur = s;
  if (s.turnKey !== turnKey || s.key !== key) {
    // Adjusted during render on the key edge (no effect), so the swap lands in the same commit.
    const hold = s.turnKey === turnKey && activity.kind === "working" && s.shown.kind !== "working";
    cur = { turnKey, key, shown: hold ? s.shown : activity, holding: hold };
    setS(cur);
  }
  const { holding } = cur;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new key or turn restarts or ends the hold
  useEffect(() => {
    if (!holding) return;
    const t = setTimeout(() => setS((p) => ({ ...p, shown: WORKING, holding: false })), HOLD_MS);
    return () => clearTimeout(t);
  }, [holding, key, turnKey]);
  return holding ? cur.shown : activity;
}

/** The open turn's activity line: derives, holds and renders; its own memo boundary so a frame
 *  that changes nothing it reads renders nothing here. */
export const TurnActivity = memo(function TurnActivity({
  open,
  live,
  startedAt,
  turnKey,
  compacting = false,
  fade = false,
}: {
  open: OpenTurnRows | undefined;
  live?: ActivityLive;
  /** The turn opened while the view was open (not on load or a switch): the line fades in. */
  fade?: boolean;
  startedAt?: string;
  turnKey: string;
  /** A compaction is running: the line reads "Compacting" whatever the rows say. */
  compacting?: boolean;
}) {
  const activity = useFallbackHold(useActivity(open, live), turnKey);
  const input = live?.toolInput;
  const shown = compacting ? COMPACTING : activity;
  // Under 1 KB (1024 bytes) the counter is noise, so it's hidden; from 1 KB on it reads "1 KB".
  const bytes =
    shown.kind === "tool_input" && (input?.bytes ?? 0) >= 1024 ? input?.bytes : undefined;
  return (
    <ActivityLine
      activity={shown}
      startedAt={startedAt}
      live={fade}
      count={
        bytes === undefined ? undefined : (
          // Keyed by the call: a new tool's input starts its own counter at once.
          <InputCount key={input?.toolUseId ?? input?.name} text={formatBytes(bytes)} />
        )
      }
    />
  );
});

/** " · 12 KB" of tool input so far, updated at most twice a second (U3 §5.1, M4). */
function InputCount({ text }: { text: string }) {
  const shown = useSampled(text);
  return (
    <span className="shrink-0 whitespace-pre tabular-nums">
      {" · "}
      <span data-activity-count>{shown}</span>
    </span>
  );
}
