import {
  apiFetch,
  type MessageAttachment,
  messageAttachmentSchema,
  type SessionEvent,
} from "@open-factory/shared";
import { z } from "zod";
import {
  type AttachmentStore,
  MAX_ATTACHMENTS,
  type UploadSummary,
  type UploadView,
} from "@/components/composer/attachments";
import { NETWORK_ERROR } from "@/components/composer/composer";
import { refOfWho } from "./who";

/** A 413 that isn't the server's JSON: a reverse proxy's own limit (U3 §13.5). */
export const PROXY_TOO_LARGE =
  "The server refused a file this large (check the proxy's upload limit).";
/** Advisory: the server enforces its own 20 MiB cap; this only saves sending a file it would refuse. */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const TOO_LARGE = "The file is larger than 20 MB.";
const EMPTY = "The file is empty.";
/** The types the server accepts as images; only these get a thumbnail. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const uploadResponseSchema = messageAttachmentSchema.required({ bytes: true });

type Entry = {
  view: UploadView;
  file: File;
  xhr?: XMLHttpRequest;
  attachment?: MessageAttachment;
  /** 429 `too_many_uploads` answers this file has had in a row. */
  busy?: number;
};

/** The server streams at most 3 uploads per uploader at once (429 past that): the rest wait their turn. */
const MAX_IN_FLIGHT = 3;
/** A 429 "too many at once" waits for one of ours to finish, or this long when none is ours (another tab's). */
const BUSY_PAUSE_MS = 1000;
/** After this many 429s in a row the file fails, with Retry. */
const MAX_BUSY = 3;

const isBusy = (xhr: XMLHttpRequest) => {
  if (xhr.status !== 429) return false;
  try {
    return (
      (JSON.parse(xhr.responseText) as { error?: { code?: unknown } })?.error?.code ===
      "too_many_uploads"
    );
  } catch {
    return false;
  }
};

// beforeunload while anything is in flight, across every agent's store (U3 §13.5).
let inFlight = 0;
const onBeforeUnload = (e: BeforeUnloadEvent) => {
  e.preventDefault();
  e.returnValue = "";
};
function flight(delta: 1 | -1) {
  const before = inFlight;
  inFlight += delta;
  if (before === 0 && inFlight === 1) window.addEventListener("beforeunload", onBeforeUnload);
  if (before === 1 && inFlight === 0) window.removeEventListener("beforeunload", onBeforeUnload);
}

/** A failure a second try can fix: a timeout, a rate limit, the server's own trouble. A refusal of the file
 *  (415, 422, 413) would fail again, so it offers only Remove. */
const transient = (status: number) => status === 408 || status === 429 || status >= 500;

function errorOf(xhr: XMLHttpRequest): string {
  try {
    const d = JSON.parse(xhr.responseText) as { error?: { message?: unknown } };
    if (typeof d?.error?.message === "string" && d.error.message) return d.error.message;
  } catch {
    // Not JSON: a proxy or the network in between answered.
  }
  return xhr.status === 413 ? PROXY_TOO_LARGE : `The upload failed (HTTP ${xhr.status}).`;
}

export type UploadStore = AttachmentStore & {
  /** The attachments of these upload ids (for the optimistic block's chips). */
  describe(ids: readonly string[]): MessageAttachment[];
  /** Drops the chips of uploads a delivered message used (a send that landed after a remount). */
  forgetUploads(uploadIds: readonly string[]): void;
  /** Aborts and forgets everything (sign-out). */
  abortAll(): void;
};

/** One agent's uploads (U3 §13.5). Exported for tests; the app uses `uploadsFor`. */
export function createUploadStore(agentRef: string): UploadStore {
  const entries = new Map<string, Entry>();
  let keys: readonly string[] = [];
  let summary: UploadSummary = { count: 0, pending: 0, failed: 0 };
  const listeners = new Set<() => void>();
  const keyListeners = new Map<string, Set<() => void>>();
  const described = new Map<string, MessageAttachment>();
  // Taken by a send in flight: back on a failure, forgotten once it lands.
  const away = new Map<string, Entry>();
  // Progress ticks wait for the next frame; status changes go at once.
  const dirty = new Set<string>();
  let frame: number | undefined;
  let seq = 0;
  // Files waiting for a slot, in order, and how many are streaming now.
  const waiting: string[] = [];
  let active = 0;
  // After a 429 for "too many at once": nothing starts until one of ours finishes (or the pause ends).
  let paused = false;
  let pauseTimer: ReturnType<typeof setTimeout> | undefined;

  const notifyKey = (k: string) => {
    for (const l of keyListeners.get(k) ?? []) l();
  };
  /** Keys or a count changed: new snapshots, then the list's listeners. */
  const changed = () => {
    // The same array while the set of files is the same (a status change renders no list).
    if (keys.length !== entries.size || keys.some((k) => !entries.has(k)))
      keys = [...entries.keys()];
    const views = [...entries.values()].map((e) => e.view);
    const next = {
      count: views.length,
      pending: views.filter((v) => v.status === "uploading").length,
      failed: views.filter((v) => v.status === "failed").length,
    };
    if (
      next.count !== summary.count ||
      next.pending !== summary.pending ||
      next.failed !== summary.failed
    )
      summary = next;
    for (const l of listeners) l();
  };
  const setView = (k: string, patch: Partial<UploadView>) => {
    const e = entries.get(k);
    if (!e) return;
    e.view = { ...e.view, ...patch };
  };
  const flush = () => {
    frame = undefined;
    const ks = [...dirty];
    dirty.clear();
    for (const k of ks) notifyKey(k);
  };

  /** Into the line: it starts when a slot is free (the chip shows 0% meanwhile). */
  function enqueue(k: string, front = false) {
    if (front) waiting.unshift(k);
    else waiting.push(k);
    flight(1);
    pump();
  }
  function unqueue(k: string) {
    const i = waiting.indexOf(k);
    if (i < 0) return false;
    waiting.splice(i, 1);
    flight(-1);
    return true;
  }
  function pump() {
    while (!paused && active < MAX_IN_FLIGHT && waiting.length > 0) {
      const k = waiting.shift() as string;
      flight(-1); // `send` counts it again while it streams
      const e = entries.get(k);
      if (e?.view.status === "uploading" && !e.xhr) send(k);
    }
  }
  function resume() {
    paused = false;
    if (pauseTimer !== undefined) clearTimeout(pauseTimer);
    pauseTimer = undefined;
    pump();
  }

  function send(k: string) {
    const e = entries.get(k);
    if (!e) return;
    active++;
    const xhr = new XMLHttpRequest();
    e.xhr = xhr;
    xhr.open("POST", `/api/agents/${encodeURIComponent(agentRef)}/uploads`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.setRequestHeader("x-upload-name", encodeURIComponent(e.file.name));
    flight(1);
    let settled = false;
    const settle = () => {
      if (settled) return false;
      settled = true;
      active--;
      flight(-1);
      if (e.xhr === xhr) e.xhr = undefined;
      dirty.delete(k);
      return entries.get(k) === e;
    };
    xhr.upload.onprogress = (p) => {
      if (settled || !p.lengthComputable || p.total <= 0) return;
      setView(k, { progress: Math.min(1, p.loaded / p.total) });
      dirty.add(k);
      if (frame === undefined) frame = requestAnimationFrame(flush);
    };
    xhr.onload = () => {
      const mine = settle();
      // The server is streaming too many already: back to the front of the line, without a failure.
      if (mine && isBusy(xhr) && (e.busy ?? 0) < MAX_BUSY) {
        e.busy = (e.busy ?? 0) + 1;
        setView(k, { progress: 0 });
        notifyKey(k);
        paused = true;
        enqueue(k, true);
        if (active === 0) pauseTimer = setTimeout(resume, BUSY_PAUSE_MS);
        return;
      }
      resume();
      if (!mine) return;
      e.busy = 0;
      if (xhr.status >= 200 && xhr.status < 300) {
        const parsed = (() => {
          try {
            return uploadResponseSchema.safeParse(JSON.parse(xhr.responseText));
          } catch {
            return undefined;
          }
        })();
        if (parsed?.success) {
          const attachment = parsed.data;
          e.attachment = attachment;
          described.set(attachment.uploadId, attachment);
          setView(k, { status: "done", progress: 1 });
        } else
          setView(k, {
            status: "failed",
            error: "The server's answer couldn't be read.",
            retryable: true,
          });
      } else
        setView(k, { status: "failed", error: errorOf(xhr), retryable: transient(xhr.status) });
      notifyKey(k);
      changed();
    };
    xhr.onerror = () => {
      const mine = settle();
      resume();
      if (!mine) return;
      setView(k, { status: "failed", error: NETWORK_ERROR, retryable: true });
      notifyKey(k);
      changed();
    };
    xhr.onabort = () => {
      settle();
      resume();
    };
    xhr.send(e.file);
  }

  function drop(k: string) {
    const e = entries.get(k);
    if (!e) return undefined;
    entries.delete(k);
    dirty.delete(k);
    return e;
  }

  const store: UploadStore = {
    keys: () => keys,
    summary: () => summary,
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    get: (k) => entries.get(k)?.view,
    subscribeKey(k, l) {
      const set = keyListeners.get(k) ?? new Set<() => void>();
      keyListeners.set(k, set);
      set.add(l);
      return () => {
        set.delete(l);
        if (set.size === 0) keyListeners.delete(k);
      };
    },
    add(files) {
      const room = Math.max(0, MAX_ATTACHMENTS - entries.size);
      const taken = files.slice(0, room);
      for (const file of taken) {
        const key = `u${++seq}`;
        const image = IMAGE_TYPES.has(file.type);
        const refusal = file.size === 0 ? EMPTY : file.size > MAX_UPLOAD_BYTES ? TOO_LARGE : "";
        const entry: Entry = {
          file,
          view: {
            key,
            name: file.name,
            bytes: file.size,
            image,
            status: refusal ? "failed" : "uploading",
            progress: 0,
            retryable: false,
            ...(refusal ? { error: refusal } : {}),
          },
        };
        entries.set(key, entry);
        if (image && typeof createImageBitmap === "function" && !refusal)
          createImageBitmap(file, { resizeWidth: 64 }).then(
            (bitmap) => {
              if (entries.get(key) !== entry) return bitmap.close();
              setView(key, { thumb: bitmap });
              notifyKey(key);
            },
            () => {}, // undecodable here: the icon stays; the server decides what it is
          );
        if (!refusal) enqueue(key);
      }
      if (taken.length) changed();
      return taken.length;
    },
    retry(k) {
      const e = entries.get(k);
      if (e?.view.status !== "failed" || !e.view.retryable) return;
      const { error: _error, ...rest } = e.view;
      e.view = { ...rest, status: "uploading", progress: 0 };
      e.busy = 0;
      enqueue(k);
      notifyKey(k);
      changed();
    },
    remove(k) {
      const e = drop(k);
      if (!e) return;
      unqueue(k);
      // Aborting deletes the server's temp file; a finished upload is deleted at once (Q42).
      e.xhr?.abort();
      const id = e.attachment?.uploadId;
      if (id)
        void apiFetch(
          `/api/agents/${encodeURIComponent(agentRef)}/uploads/${encodeURIComponent(id)}`,
          {
            method: "DELETE",
            schema: z.unknown(),
          },
        ).catch(() => {}); // the 24h sweep deletes what this couldn't
      e.view.thumb?.close();
      notifyKey(k);
      changed();
    },
    take() {
      const done = [...entries.values()].filter((e) => e.view.status === "done" && e.attachment);
      for (const e of done) {
        entries.delete(e.view.key);
        away.set(e.view.key, e);
      }
      if (done.length) changed();
      return {
        ids: done.map((e) => e.attachment?.uploadId as string),
        views: done.map((e) => e.view),
      };
    },
    restore(taken) {
      const back = taken.views.flatMap((v) => {
        const e = away.get(v.key);
        away.delete(v.key);
        return e ? [e] : [];
      });
      if (back.length === 0) return;
      // Back in front of anything attached since, up to the limit (the rest are dropped unsent).
      const rest = [...entries.values()];
      entries.clear();
      for (const e of [...back, ...rest].slice(0, MAX_ATTACHMENTS)) entries.set(e.view.key, e);
      changed();
    },
    settle(taken) {
      for (const v of taken.views) {
        away.get(v.key)?.view.thumb?.close();
        away.delete(v.key);
      }
    },
    forgetUploads(ids) {
      const used = new Set(ids);
      let any = false;
      for (const [k, e] of entries)
        if (e.attachment && used.has(e.attachment.uploadId)) {
          entries.delete(k);
          e.view.thumb?.close();
          notifyKey(k);
          any = true;
        }
      if (any) changed();
    },
    abortAll() {
      for (const k of [...waiting]) unqueue(k);
      paused = false;
      if (pauseTimer !== undefined) clearTimeout(pauseTimer);
      pauseTimer = undefined;
      for (const e of [...entries.values(), ...away.values()]) {
        e.xhr?.abort();
        e.view.thumb?.close();
      }
      entries.clear();
      away.clear();
      described.clear();
      changed();
    },
    forget(taken) {
      let any = false;
      for (const v of taken.views) {
        const e = entries.get(v.key) ?? away.get(v.key);
        away.delete(v.key);
        if (entries.delete(v.key)) any = true;
        e?.view.thumb?.close();
      }
      if (any) changed();
    },
    describe: (ids) =>
      ids.map((id) => described.get(id)).filter((a): a is MessageAttachment => a !== undefined),
  };
  return store;
}

const stores = new Map<string, UploadStore>();
const storeKey = (user: string | undefined, agentRef: string) => `${user ?? ""}:${agentRef}`;
/** The agent's uploads for this user, kept for the page's life, so leaving the session and coming back keeps
 *  them. Keyed by the user: another user signing in on this tab never sees them. */
export function uploadsFor(user: string | undefined, agentRef: string): UploadStore {
  const key = storeKey(user, agentRef);
  const s = stores.get(key) ?? createUploadStore(agentRef);
  stores.set(key, s);
  return s;
}

/** A user change: every other user's uploads are aborted (beforeunload disarms) and forgotten, with their
 *  chips and thumbnails. */
export function dropUploadsExcept(user: string | undefined) {
  const keep = `${user ?? ""}:`;
  for (const [k, s] of stores)
    if (!k.startsWith(keep)) {
      s.abortAll();
      stores.delete(k);
    }
}

/** Sign-out: nothing of this user's files stays in memory. */
export function resetUploads() {
  for (const s of stores.values()) s.abortAll();
  stores.clear();
}

const ATTACHED = /^\[attached: \.factory\/uploads\/\d{8}-([0-9a-f-]{36})-[A-Za-z0-9._-]+\]$/;
/**
 * The body without the `[attached: …]` lines the server appended for this message's own uploads (U3 §13.5): only the
 * trailing lines whose stored name carries one of `attachments`' ids, and the blank line before them. Anything else,
 * a typed `[attached: ../x]` included, stays text.
 */
export function stripAttachedLines(
  body: string,
  attachments: readonly MessageAttachment[] | undefined,
): string {
  if (!attachments?.length) return body;
  const ids = new Set(attachments.map((a) => a.uploadId));
  const lines = body.split("\n");
  let end = lines.length;
  while (end > 0) {
    const m = ATTACHED.exec(lines[end - 1] as string);
    if (!m || !ids.has(m[1] as string)) break;
    ids.delete(m[1] as string);
    end--;
  }
  if (end === lines.length) return body;
  if (end > 0 && lines[end - 1] === "") end--;
  return lines.slice(0, end).join("\n");
}

/** The uploads your messages after `afterSeq` used (newest first; stops at `afterSeq`, so a call per frame is cheap). */
export function uploadsUsedSince(
  ordered: readonly SessionEvent[],
  afterSeq: number,
  selfRef: string | undefined,
): string[] {
  const out: string[] = [];
  if (!selfRef) return out;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const se = ordered[i] as SessionEvent;
    if (se.seq <= afterSeq) break;
    if (se.event.type !== "message_in") continue;
    for (const m of se.event.messages)
      if (refOfWho(m.from) === selfRef) for (const a of m.attachments ?? []) out.push(a.uploadId);
  }
  return out;
}

/** ↑ in an empty composer (U3 §13.2, I1 §5): your newest raw input in the loaded timeline, as typed. `selfTag` is
 *  the signed-in human's tag, which is what a stored `operator_input` names. */
export function recallText(
  ordered: readonly SessionEvent[],
  selfTag: string | undefined,
): string | undefined {
  if (!selfTag) return undefined;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const ev = (ordered[i] as SessionEvent).event;
    if (ev.type === "operator_input" && ev.by === selfTag) return ev.text;
  }
  return undefined;
}
