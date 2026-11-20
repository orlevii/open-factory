import type { ImageItem } from "@open-factory/shared";
import { CircleAlert, CircleCheck } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useWs } from "@/lib/ws-context";
import { fetchImageLog } from "./api";

type LogState = "building" | "succeeded" | "failed" | null;

// CSI sequences (colours, cursor moves) and OSC sequences (titles, links) from Docker's build output.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI = new RegExp(
  `${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[@-Z\\\\-_]`,
  "g",
);
export const stripAnsi = (s: string) => s.replace(ANSI, "");

/** "12s", "1m 12s", "1h 2m". */
export function formatBuildDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * The build's lines: the log endpoint for what came before, then `image_build` frames. A frame carries only the
 * lines since the last batch, so they are appended only when this panel saw the build start (its first frame has
 * no lines); a panel that joined a running build refetches the log on each frame instead, since it can't tell
 * which of a batch's lines its snapshot already holds.
 */
function useBuildLog(name: string) {
  const hub = useWs();
  const [log, setLog] = useState<{ state: LogState; lines: string[] }>();
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);
  const live = useRef(false);

  const refetch = useCallback(() => {
    const mine = ++seq.current;
    fetchImageLog(name).then(
      (r) => {
        if (mine !== seq.current || live.current) return;
        setFailed(false);
        setLog({ state: r.state, lines: r.lines.map(stripAnsi) });
      },
      () => {
        if (mine === seq.current && !live.current) setFailed(true);
      },
    );
  }, [name]);

  useEffect(() => {
    // A (re)connect may have missed frames: start from the snapshot again.
    live.current = false;
    const off = hub.listen((m) => {
      if (m.type !== "image_build" || m.name !== name) return;
      if (m.state === "building" && !m.lines) {
        live.current = true;
        seq.current++; // an in-flight snapshot is older than this build
        setFailed(false);
        setLog({ state: "building", lines: [] });
        return;
      }
      if (!live.current) {
        if (m.state !== "building") setLog((l) => l && { ...l, state: m.state });
        refetch();
        return;
      }
      const more = (m.lines ?? []).map(stripAnsi);
      setLog((l) => ({
        state: m.state,
        lines: more.length ? [...(l?.lines ?? []), ...more] : (l?.lines ?? []),
      }));
    });
    refetch();
    return off;
  }, [hub, name, refetch]);

  return { log, failed };
}

export function BuildLog({ name, item }: { name: string; item?: ImageItem }) {
  const { log, failed } = useBuildLog(name);
  const ref = useRef<HTMLPreElement>(null);
  const [follow, setFollow] = useState(true);
  const [copy, setCopy] = useState<"copied" | "failed">();
  const text = log?.lines.join("\n") ?? "";

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every new line while following
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [text, follow]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight <= 4);
  };

  const copyAll = () => {
    const write = navigator.clipboard?.writeText(text);
    if (!write) return setCopy("failed");
    write.then(
      () => setCopy("copied"),
      () => setCopy("failed"),
    );
  };

  // The outcome comes from the list's lastBuild (duration, error) once the list has caught up with the build.
  const last = item && item.status !== "building" ? item.lastBuild : undefined;
  const ended = log?.state === "succeeded" || log?.state === "failed";

  return (
    <div className="grid gap-2 rounded-lg border border-border bg-card p-3">
      {failed && !log && (
        <p role="alert" className="text-[0.8125rem] text-muted-foreground">
          Couldn't load images.
        </p>
      )}
      <pre
        ref={ref}
        role="log"
        aria-live="off"
        aria-label={`Build log for ${name}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable log must be reachable to scroll with the keyboard.
        tabIndex={0}
        onScroll={onScroll}
        className="h-[20lh] overflow-auto font-mono text-[0.8125rem] leading-[1.5] whitespace-pre-wrap break-words focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        {text}
      </pre>
      {ended && last?.state === "succeeded" && log?.state === "succeeded" && (
        <p className="flex items-center gap-1.5 text-[0.8125rem]">
          <CircleCheck aria-hidden="true" className="size-3.5 shrink-0 text-success" />
          Built {name} in {formatBuildDuration(last.durationMs)}.
        </p>
      )}
      {ended && last?.state === "failed" && log?.state === "failed" && (
        <div className="grid gap-0.5 text-[0.8125rem]">
          <p className="flex items-center gap-1.5">
            <CircleAlert aria-hidden="true" className="size-3.5 shrink-0 text-destructive" />
            Build failed
          </p>
          {last.error && (
            <p className="font-mono break-words text-muted-foreground">{last.error}</p>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {!follow && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const el = ref.current;
              if (el) el.scrollTop = el.scrollHeight;
              setFollow(true);
            }}
          >
            Jump to latest
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={copyAll}>
          Copy
        </Button>
        <span aria-live="polite" className="text-[0.8125rem] text-muted-foreground">
          {copy === "copied" ? "Copied." : copy === "failed" ? "Couldn't copy" : ""}
        </span>
      </div>
    </div>
  );
}
