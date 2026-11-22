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
export function createUploadStore(slug: string): UploadStore {
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

  function start(k: string) {
    const e = entries.get(k);
    if (!e) return;
    const xhr = new XMLHttpRequest();
    e.xhr = xhr;
    xhr.open("POST", `/api/agents/${encodeURIComponent(slug)}/uploads`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.setRequestHeader("x-upload-name", encodeURIComponent(e.file.name));
    flight(1);
    let settled = false;
    const settle = () => {
      if (settled) return false;
      settled = true;
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
      if (!settle()) return;
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
      if (!settle()) return;
      setView(k, { status: "failed", error: NETWORK_ERROR, retryable: true });
      notifyKey(k);
      changed();
    };
    xhr.onabort = () => {
      settle();
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
        if (!refusal) start(key);
      }
      if (taken.length) changed();
      return taken.length;
    },
    retry(k) {
      const e = entries.get(k);
      if (e?.view.status !== "failed" || !e.view.retryable) return;
      const { error: _error, ...rest } = e.view;
      e.view = { ...rest, status: "uploading", progress: 0 };
      start(k);
      notifyKey(k);
      changed();
    },
    remove(k) {
      const e = drop(k);
      if (!e) return;
      // Aborting deletes the server's temp file; a finished upload is deleted at once (Q42).
      e.xhr?.abort();
      const id = e.attachment?.uploadId;
      if (id)
        void apiFetch(`/api/agents/${encodeURIComponent(slug)}/uploads/${encodeURIComponent(id)}`, {
          method: "DELETE",
          schema: z.unknown(),
        }).catch(() => {}); // the 24h sweep deletes what this couldn't
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
const storeKey = (user: string | undefined, slug: string) => `${user ?? ""}:${slug}`;
/** The agent's uploads for this user, kept for the page's life, so leaving the session and coming back keeps
 *  them. Keyed by the user: another user signing in on this tab never sees them. */
export function uploadsFor(user: string | undefined, slug: string): UploadStore {
  const key = storeKey(user, slug);
  const s = stores.get(key) ?? createUploadStore(slug);
  stores.set(key, s);
  return s;
}

/** A user change: every other user's uploads are aborted (beforeunload disarms) and forgotten, with their
 *  chips, thumbnails and remembered sends. */
export function dropUploadsExcept(user: string | undefined) {
  const keep = `${user ?? ""}:`;
  for (const [k, s] of stores)
    if (!k.startsWith(keep)) {
      s.abortAll();
      stores.delete(k);
    }
  if (user === undefined) sent.clear();
}

/** Sign-out: nothing of this user's files stays in memory. */
export function resetUploads() {
  for (const s of stores.values()) s.abortAll();
  stores.clear();
  sent.clear();
}

// This tab's sends with files, by `clientMessageId`: their queue items show the chips too.
const sent = new Map<string, readonly MessageAttachment[]>();
export const rememberSent = (clientMessageId: string, a: readonly MessageAttachment[]) => {
  if (a.length) sent.set(clientMessageId, a);
};
export const attachmentsSentWith = (clientMessageId: string | undefined) =>
  clientMessageId ? sent.get(clientMessageId) : undefined;

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
  self: string | undefined,
): string[] {
  const out: string[] = [];
  if (!self) return out;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const se = ordered[i] as SessionEvent;
    if (se.seq <= afterSeq) break;
    if (se.event.type !== "message_in") continue;
    for (const m of se.event.messages)
      if (m.from === `@${self}`) for (const a of m.attachments ?? []) out.push(a.uploadId);
  }
  return out;
}

/** ↑ in an empty composer (U3 §13.2): your newest message in the loaded timeline, its text only (D6). */
export function recallText(
  ordered: readonly SessionEvent[],
  self: string | undefined,
): string | undefined {
  if (!self) return undefined;
  const from = `@${self}`;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const ev = (ordered[i] as SessionEvent).event;
    if (ev.type !== "message_in") continue;
    for (let j = ev.messages.length - 1; j >= 0; j--) {
      const m = ev.messages[j];
      if (m && m.from === from && m.kind === "message")
        return stripAttachedLines(m.body, m.attachments);
    }
  }
  return undefined;
}
