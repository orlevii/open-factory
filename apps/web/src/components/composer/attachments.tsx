import { FileText, RotateCw, X } from "lucide-react";
import { memo, useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { MiddleTruncate } from "@/components/middle-truncate";
import { Button } from "@/components/ui/button";

/** One file in the composer (U3 §13.5). A new object on every change, so a snapshot compares by identity. */
export type UploadView = {
  readonly key: string;
  /** The original name, as the person chose it (shown through `displayName`, never as HTML). */
  readonly name: string;
  readonly bytes: number;
  /** A guess from the browser's type, for the icon only; the server sniffs the content. */
  readonly image: boolean;
  readonly status: "uploading" | "done" | "failed";
  /** 0..1 while uploading. */
  readonly progress: number;
  readonly error?: string;
  /** A failure Retry can fix (the server's answer or the network); a client-side refusal can't. */
  readonly retryable: boolean;
  /** A 64px-wide bitmap of an image (`createImageBitmap`), never the full-size file. */
  readonly thumb?: ImageBitmap;
};

/** What Send reads (a cached object: it changes only when a count does). */
export type UploadSummary = {
  readonly count: number;
  readonly pending: number;
  readonly failed: number;
};

/** The uploads of a send that took them: put back if the send fails, forgotten once it lands. */
export type TakenUploads = { readonly ids: string[]; readonly views: readonly UploadView[] };

/**
 * A composer's files (U3 §13.5): the per-agent store outside the composer (`features/session/uploads.ts`), so leaving
 * the session keeps them. `subscribe` covers the list and the summary; `subscribeKey` one file's view, whose progress
 * ticks reach only it (review note m12).
 */
export interface AttachmentStore {
  keys(): readonly string[];
  summary(): UploadSummary;
  subscribe(listener: () => void): () => void;
  get(key: string): UploadView | undefined;
  subscribeKey(key: string, listener: () => void): () => void;
  /** Starts uploading as many of `files` as fit under the limit; returns how many it took. */
  add(files: readonly File[]): number;
  retry(key: string): void;
  /** Cancels an upload in flight, or deletes a finished one on the server. */
  remove(key: string): void;
  /** The finished uploads, out of the composer, for a send. */
  take(): TakenUploads;
  restore(taken: TakenUploads): void;
  settle(taken: TakenUploads): void;
  /** Drops these chips without deleting their uploads: a send that showed up late took them. */
  forget(taken: TakenUploads): void;
}

export const MAX_ATTACHMENTS = 10;
export const TOO_MANY = `Up to ${MAX_ATTACHMENTS} files per message.`;
export const NO_FOLDERS = "Folders can't be attached; attach the files inside.";

// Format characters (bidi overrides such as U+202E, zero-width joiners) are stripped for display (U3 §13.5).
const FORMAT_CHARS = /\p{Cf}/gu;
/** A file name as text for the chip: Cf characters stripped. Always rendered as a text node. */
export const displayName = (name: string) => name.replace(FORMAT_CHARS, "");

export const waitingFor = (n: number) => `Waiting for ${n} ${n === 1 ? "upload" : "uploads"}`;
export const RETRY_OR_REMOVE = "Remove or retry the failed file";
/** Why Send waits on the files, if it does. */
export function sendBlockedBy(s: UploadSummary): string | undefined {
  if (s.pending > 0) return waitingFor(s.pending);
  if (s.failed > 0) return RETRY_OR_REMOVE;
  return undefined;
}

/** A thumbnail drawn from the stored bitmap (drawImage keeps it, so a remount can draw it again). */
function Thumb({ bitmap }: { bitmap: ImageBitmap }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = bitmap.width;
    c.height = bitmap.height;
    try {
      c.getContext("2d")?.drawImage(bitmap, 0, 0);
    } catch {
      // A closed bitmap (removed meanwhile) draws nothing.
    }
  }, [bitmap]);
  return <canvas ref={ref} data-thumb className="size-7 shrink-0 rounded-[3px] object-cover" />;
}

/** One file's chip: it subscribes to its own view, so its progress renders it alone (m12). */
const UploadChip = memo(function UploadChip({
  store,
  id,
  hidden,
}: {
  store: AttachmentStore;
  id: string;
  /** Past the two rows while collapsed: clipped, out of the tab order. */
  hidden: boolean;
}) {
  const subscribe = useCallback((l: () => void) => store.subscribeKey(id, l), [store, id]);
  const get = useCallback(() => store.get(id), [store, id]);
  const v = useSyncExternalStore(subscribe, get);
  if (!v) return null;
  const name = displayName(v.name);
  const pct = Math.round(v.progress * 100);
  const failed = v.status === "failed";
  return (
    <li
      data-upload-chip
      data-status={v.status}
      inert={hidden}
      aria-hidden={hidden || undefined}
      className={`relative flex h-9 max-w-[12rem] min-w-0 items-center gap-1.5 overflow-hidden rounded-sm border bg-background pr-0.5 pl-1 ${failed ? "border-destructive" : "border-border"}`}
    >
      {v.thumb ? (
        <Thumb bitmap={v.thumb} />
      ) : (
        <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="flex min-w-0 flex-1 flex-col text-[0.8125rem] leading-4">
        <span dir="auto" className="min-w-0">
          <MiddleTruncate text={name} keepEnd />
        </span>
        {failed ? (
          <span title={v.error} className="truncate text-xs leading-4 text-destructive">
            {v.error}
          </span>
        ) : v.status === "uploading" ? (
          <span className="text-xs leading-4 text-muted-foreground tabular-nums">{pct}%</span>
        ) : null}
      </span>
      {failed && v.retryable ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Retry ${name}`}
          onClick={() => store.retry(id)}
        >
          <RotateCw aria-hidden="true" />
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`${v.status === "uploading" ? "Cancel" : "Remove"} ${name}`}
        onClick={() => store.remove(id)}
      >
        <X aria-hidden="true" />
      </Button>
      {v.status === "uploading" ? (
        // Determinate, updated without transition (Q43): each tick is a new width at once.
        <span
          role="progressbar"
          aria-label={`Uploading ${name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          data-upload-bar
          className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-foreground transition-none"
          style={{ transform: `scaleX(${v.progress})` }}
        />
      ) : null}
    </li>
  );
});

/**
 * The chips above the textarea (U3 §13.5): at most two rows, then "+N files" expands them in place. The list renders
 * on a file added or removed, never on a progress tick.
 */
export const AttachmentChips = memo(function AttachmentChips({
  store,
}: {
  store: AttachmentStore;
}) {
  const keys = useSyncExternalStore(store.subscribe, store.keys);
  const listRef = useRef<HTMLUListElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [hidden, setHidden] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keys change which chips there are to measure
  useLayoutEffect(() => {
    const ul = listRef.current;
    if (!ul || expanded) {
      setHidden(0);
      return;
    }
    const measure = () => {
      const items = [...ul.children] as HTMLElement[];
      const tops = [...new Set(items.map((i) => i.offsetTop))].sort((a, b) => a - b);
      const third = tops[2];
      setHidden(third === undefined ? 0 : items.filter((i) => i.offsetTop >= third).length);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(ul);
    return () => ro.disconnect();
  }, [keys, expanded]);
  if (keys.length === 0) return null;
  const firstHidden = keys.length - hidden;
  return (
    <div data-attachment-chips className="flex items-end gap-1.5 px-2 pt-2">
      <ul
        ref={listRef}
        aria-label="Attached files"
        // Two rows of 36px chips and the gap between them.
        className={`flex min-w-0 flex-1 flex-wrap gap-1.5 ${expanded ? "" : "max-h-[calc(4.5rem_+_0.375rem)] overflow-hidden"}`}
      >
        {keys.map((k, i) => (
          <UploadChip key={k} store={store} id={k} hidden={i >= firstHidden} />
        ))}
      </ul>
      {hidden > 0 ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="shrink-0 text-muted-foreground"
          onClick={() => setExpanded(true)}
        >
          +{hidden} {hidden === 1 ? "file" : "files"}
        </Button>
      ) : null}
    </div>
  );
});
