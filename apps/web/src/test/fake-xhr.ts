import { vi } from "vitest";

type Listener = (e: ProgressEvent) => void;

/** One request the code under test opened: drive it with `progress`, `respond`, `fail`. */
export class FakeXhr {
  static all: FakeXhr[] = [];
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: unknown;
  withCredentials = false;
  status = 0;
  responseText = "";
  aborted = false;
  onload: Listener | null = null;
  onerror: Listener | null = null;
  onabort: Listener | null = null;
  upload: { onprogress: Listener | null } = { onprogress: null };
  constructor() {
    FakeXhr.all.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k.toLowerCase()] = v;
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.(new ProgressEvent("abort"));
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.(
      new ProgressEvent("progress", { lengthComputable: true, loaded, total }),
    );
  }
  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = typeof body === "string" ? body : JSON.stringify(body);
    this.onload?.(new ProgressEvent("load"));
  }
  fail() {
    this.onerror?.(new ProgressEvent("error"));
  }
}

/** Replaces `XMLHttpRequest` for the test; `FakeXhr.all` lists what was opened, newest last. */
export function installFakeXhr() {
  FakeXhr.all = [];
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  return FakeXhr;
}

/** The newest request, failing the test when there is none. */
export function lastXhr(): FakeXhr {
  const x = FakeXhr.all.at(-1);
  if (!x) throw new Error("no XMLHttpRequest was opened");
  return x;
}

/** `requestAnimationFrame` held until `flush()`, so a test sees what one frame coalesces. */
export function holdFrames() {
  let queue: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    queue.push(cb);
    return queue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  return {
    pending: () => queue.length,
    flush() {
      const q = queue;
      queue = [];
      for (const cb of q) cb(0);
    },
  };
}

export const file = (name: string, bytes: number | string = "hello", type = "text/plain") =>
  new File([typeof bytes === "string" ? bytes : new Uint8Array(bytes)], name, { type });
