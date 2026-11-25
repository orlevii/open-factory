import type { MessageAttachment, SessionEvent } from "@open-factory/shared";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { NETWORK_ERROR } from "@/components/composer/composer";
import { FakeXhr, file, holdFrames, installFakeXhr, lastXhr } from "@/test/fake-xhr";
import { json, mockApi } from "@/test/mock-api";
import {
  createUploadStore,
  dropUploadsExcept,
  PROXY_TOO_LARGE,
  recallText,
  resetUploads,
  stripAttachedLines,
  uploadsFor,
} from "./uploads";

let frames: ReturnType<typeof holdFrames>;
beforeEach(() => {
  installFakeXhr();
  frames = holdFrames();
});
afterEach(() => {
  // Uploads a test left in flight end here, so the page-wide beforeunload count starts at zero.
  for (const x of FakeXhr.all) x.abort();
  vi.unstubAllGlobals();
});

const ok = (id: string, name = "a.txt") => ({ uploadId: id, kind: "text", bytes: 5, name });
const only = (s: ReturnType<typeof createUploadStore>) => {
  const k = s.keys()[0];
  if (!k) throw new Error("no upload");
  return k;
};

test("a file is POSTed raw, its name percent-encoded, with the session's cookie", () => {
  const s = createUploadStore("dev");
  const f = file("résumé ].txt");
  expect(s.add([f])).toBe(1);
  const x = lastXhr();
  expect(x.method).toBe("POST");
  expect(x.url).toBe("/api/agents/dev/uploads");
  expect(x.headers["content-type"]).toBe("application/octet-stream");
  expect(x.headers["x-upload-name"]).toBe(encodeURIComponent("résumé ].txt"));
  expect(x.withCredentials).toBe(true);
  expect(x.body).toBe(f);
  expect(s.get(only(s))).toMatchObject({ status: "uploading", progress: 0, name: "résumé ].txt" });
  expect(s.summary()).toEqual({ count: 1, pending: 1, failed: 0 });
});

test("progress reaches only that upload's listeners, once per animation frame", () => {
  const s = createUploadStore("dev");
  s.add([file("a.txt"), file("b.txt")]);
  const [a, b] = s.keys() as [string, string];
  const onList = vi.fn();
  const onA = vi.fn();
  const onB = vi.fn();
  s.subscribe(onList);
  s.subscribeKey(a, onA);
  s.subscribeKey(b, onB);
  const summary = s.summary();
  const xa = FakeXhr.all[0] as FakeXhr;
  xa.progress(10, 100);
  xa.progress(40, 100);
  expect(onA).not.toHaveBeenCalled();
  frames.flush();
  expect(onA).toHaveBeenCalledTimes(1);
  expect(s.get(a)?.progress).toBe(0.4);
  expect(onB).not.toHaveBeenCalled();
  expect(onList).not.toHaveBeenCalled();
  expect(s.summary()).toBe(summary); // the same object: the composer doesn't render
});

test("a 201 makes the upload done; its attachment is described for the send", () => {
  const s = createUploadStore("dev");
  s.add([file("a.txt")]);
  const onList = vi.fn();
  s.subscribe(onList);
  lastXhr().respond(201, ok("u1"));
  const k = only(s);
  expect(s.get(k)).toMatchObject({ status: "done", progress: 1 });
  expect(s.summary()).toEqual({ count: 1, pending: 0, failed: 0 });
  expect(onList).toHaveBeenCalled();
  expect(s.describe(["u1"])).toEqual([{ uploadId: "u1", name: "a.txt", kind: "text", bytes: 5 }]);
});

test("a refusal of the file shows the server's reason and offers no Retry", () => {
  const s = createUploadStore("dev");
  s.add([file("p.heic", 10, "image/heic"), file("big.png", 10, "image/png")]);
  const [a, b] = s.keys() as [string, string];
  (FakeXhr.all[0] as FakeXhr).respond(415, {
    error: { code: "unsupported_type", message: "HEIC isn't supported; export as JPEG" },
  });
  (FakeXhr.all[1] as FakeXhr).respond(422, {
    error: { message: "Image is too large (max 8000 px a side)." },
  });
  expect(s.get(a)).toMatchObject({
    status: "failed",
    error: "HEIC isn't supported; export as JPEG",
    retryable: false,
  });
  expect(s.get(b)?.retryable).toBe(false);
  expect(s.summary()).toEqual({ count: 2, pending: 0, failed: 2 });
  s.retry(a);
  expect(FakeXhr.all).toHaveLength(2);
});

test.each([408, 429, 500, 503])("a %i can be retried: Retry sends the file again", (status) => {
  const s = createUploadStore("dev");
  s.add([file("a.txt")]);
  lastXhr().respond(status, { error: { message: "Try again." } });
  const k = only(s);
  expect(s.get(k)?.retryable).toBe(true);
  s.retry(k);
  expect(FakeXhr.all).toHaveLength(2);
  expect(s.get(k)).toMatchObject({ status: "uploading", progress: 0 });
});

test("a status change keeps the list's identity; only adding or removing a file changes it", () => {
  const s = createUploadStore("dev");
  s.add([file("a.txt")]);
  const keys = s.keys();
  lastXhr().respond(201, ok("u1"));
  expect(s.keys()).toBe(keys);
  s.add([file("b.txt")]);
  expect(s.keys()).not.toBe(keys);
});

test("a delivered message's uploads leave the composer without being deleted", () => {
  const api = mockApi({});
  const s = createUploadStore("dev");
  s.add([file("a.txt"), file("b.txt")]);
  (FakeXhr.all[0] as FakeXhr).respond(201, ok("u1"));
  (FakeXhr.all[1] as FakeXhr).respond(201, ok("u2", "b.txt"));
  s.forgetUploads(["u1", "other"]);
  expect(s.keys()).toHaveLength(1);
  expect(s.get(s.keys()[0] as string)?.name).toBe("b.txt");
  expect(api.calls).toEqual([]);
});

test("a user change aborts every other user's uploads, disarms beforeunload and forgets their files", () => {
  const s = uploadsFor("u-alice", "dev");
  s.add([file("secret.txt")]);
  const x = lastXhr();
  const bob = uploadsFor("u-bob", "dev");
  expect(bob).not.toBe(s);
  expect(bob.keys()).toEqual([]);
  dropUploadsExcept("u-bob");
  expect(x.aborted).toBe(true);
  expect(s.keys()).toEqual([]);
  const ev = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(ev);
  expect(ev.defaultPrevented).toBe(false);
  expect(uploadsFor("u-bob", "dev")).toBe(bob); // the kept user's store is untouched
  expect(uploadsFor("u-alice", "dev")).not.toBe(s);
  resetUploads();
  expect(uploadsFor("u-bob", "dev")).not.toBe(bob);
});

test("a non-JSON 413 (a proxy's limit) says so; a network error says the server can't be reached", () => {
  const s = createUploadStore("dev");
  s.add([file("big.txt"), file("b.txt")]);
  const [a, b] = s.keys() as [string, string];
  (FakeXhr.all[0] as FakeXhr).respond(413, "<html>Request Entity Too Large</html>");
  (FakeXhr.all[1] as FakeXhr).fail();
  expect(PROXY_TOO_LARGE).toBe(
    "The server refused a file this large (check the proxy's upload limit).",
  );
  expect(s.get(a)?.error).toBe(PROXY_TOO_LARGE);
  expect(s.get(b)?.error).toBe(NETWORK_ERROR);
});

test("removing aborts an upload in flight, and deletes a finished one on the server", async () => {
  const api = mockApi({ "DELETE /api/agents/dev/uploads/u2": () => json({}, 204) });
  const s = createUploadStore("dev");
  s.add([file("a.txt"), file("b.txt")]);
  const [a, b] = s.keys() as [string, string];
  (FakeXhr.all[1] as FakeXhr).respond(201, ok("u2", "b.txt"));
  s.remove(a);
  expect((FakeXhr.all[0] as FakeXhr).aborted).toBe(true);
  s.remove(b);
  expect(s.keys()).toEqual([]);
  await vi.waitFor(() =>
    expect(api.calls).toContainEqual(
      expect.objectContaining({ method: "DELETE", url: "/api/agents/dev/uploads/u2" }),
    ),
  );
});

test("an empty file fails at once without a request and can only be removed", () => {
  const s = createUploadStore("dev");
  s.add([file("empty.txt", 0)]);
  expect(FakeXhr.all).toHaveLength(0);
  expect(s.get(only(s))).toMatchObject({
    status: "failed",
    error: "The file is empty.",
    retryable: false,
  });
});

test("at most 10 files per message", () => {
  const s = createUploadStore("dev");
  const files = Array.from({ length: 12 }, (_, i) => file(`f${i}.txt`));
  expect(s.add(files.slice(0, 4))).toBe(4);
  expect(s.add(files.slice(4))).toBe(6);
  expect(s.keys()).toHaveLength(10);
  expect(s.add([file("more.txt")])).toBe(0);
});

test("leaving the page asks while an upload is in flight, and not after", () => {
  const s = createUploadStore("dev");
  s.add([file("a.txt")]);
  const ev = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(ev);
  expect(ev.defaultPrevented).toBe(true);
  lastXhr().respond(201, ok("u1"));
  const after = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(after);
  expect(after.defaultPrevented).toBe(false);
});

test("take hands the finished uploads to a send; restore puts them back, settle forgets them", () => {
  const s = createUploadStore("dev");
  s.add([file("a.txt")]);
  lastXhr().respond(201, ok("u1"));
  const taken = s.take();
  expect(taken.ids).toEqual(["u1"]);
  expect(s.keys()).toEqual([]);
  s.restore(taken);
  expect(s.keys()).toHaveLength(1);
  const again = s.take();
  s.settle(again);
  expect(s.keys()).toEqual([]);
});

test("the store is per agent and outlives the composer", () => {
  expect(uploadsFor("u1", "dev")).toBe(uploadsFor("u1", "dev"));
  expect(uploadsFor("u1", "dev")).not.toBe(uploadsFor("u1", "other"));
});

test("an image gets a 64px-wide bitmap thumbnail; never the full-size file", async () => {
  const bitmap = { width: 64, height: 48, close: vi.fn() };
  const createImageBitmap = vi.fn(async () => bitmap);
  vi.stubGlobal("createImageBitmap", createImageBitmap);
  const s = createUploadStore("dev");
  const img = file("shot.png", 20, "image/png");
  s.add([img, file("notes.txt")]);
  expect(createImageBitmap).toHaveBeenCalledTimes(1);
  expect(createImageBitmap).toHaveBeenCalledWith(img, { resizeWidth: 64 });
  const k = s.keys()[0] as string;
  await vi.waitFor(() => expect(s.get(k)?.thumb).toBe(bitmap));
  s.remove(k);
  expect(bitmap.close).toHaveBeenCalled();
});

const att = (uploadId: string, name = "a.png"): MessageAttachment => ({
  uploadId,
  name,
  kind: "image",
  bytes: 120,
});
const ID = "0b6f1c1e-6a4e-4c1a-9a43-1d1f6f8f2a10";

test("only the lines of the message's own uploads are hidden; a typed one stays text", () => {
  const body = `look\n[attached: ../x]\n\n[attached: .factory/uploads/20261122-${ID}-a.png]`;
  expect(stripAttachedLines(body, [att(ID)])).toBe("look\n[attached: ../x]");
  expect(stripAttachedLines(body, undefined)).toBe(body);
  expect(stripAttachedLines(body, [att("0b6f1c1e-0000-4c1a-9a43-1d1f6f8f2a10")])).toBe(body);
  expect(stripAttachedLines("[attached: ../x]", [att(ID)])).toBe("[attached: ../x]");
});

test("recall is your newest operator_input in the loaded timeline, as typed", () => {
  const ev = (seq: number, by: string, text: string) =>
    ({
      seq,
      agentSlug: "dev",
      turnId: null,
      at: "2026-11-22T10:00:00.000Z",
      event: { type: "operator_input", text, by, byKind: "human", entryId: `e${seq}` },
    }) as SessionEvent;
  const ordered = [
    ev(1, "@alice", "older"),
    ev(2, "@alice", "/context  "),
    ev(3, "@bob", "not mine"),
  ];
  expect(recallText(ordered, "alice")).toBe("/context  ");
  expect(recallText(ordered, "carol")).toBeUndefined();
  expect(recallText([], "alice")).toBeUndefined();
});

test("at most 3 files upload at once; the rest wait at 0% and start as slots free", () => {
  const s = createUploadStore("dev");
  s.add(Array.from({ length: 5 }, (_, i) => file(`f${i}.txt`)));
  expect(FakeXhr.all).toHaveLength(3);
  const keys = s.keys();
  expect(keys.map((k) => s.get(k)?.status)).toEqual(Array(5).fill("uploading"));
  expect(s.get(keys[4] as string)?.progress).toBe(0);
  expect(s.summary().pending).toBe(5);
  (FakeXhr.all[0] as FakeXhr).respond(201, ok("u0", "f0.txt"));
  expect(FakeXhr.all).toHaveLength(4);
  s.remove(keys[1] as string); // cancelling one in flight frees its slot too
  expect(FakeXhr.all).toHaveLength(5);
  expect(lastXhr().headers["x-upload-name"]).toBe("f4.txt");
});

test("a waiting file removed before its turn never uploads", () => {
  const s = createUploadStore("dev");
  s.add(Array.from({ length: 4 }, (_, i) => file(`f${i}.txt`)));
  s.remove(s.keys()[3] as string);
  (FakeXhr.all[0] as FakeXhr).respond(201, ok("u0", "f0.txt"));
  expect(FakeXhr.all).toHaveLength(3);
});

test("a 429 too_many_uploads waits for a slot and tries again by itself", () => {
  const s = createUploadStore("dev");
  s.add([file("a.txt"), file("b.txt")]);
  const [a, b] = FakeXhr.all as [FakeXhr, FakeXhr];
  b.respond(429, {
    error: {
      code: "too_many_uploads",
      message: "Too many uploads at once; wait for one to finish.",
    },
  });
  const kb = s.keys()[1] as string;
  expect(s.get(kb)?.status).toBe("uploading");
  expect(FakeXhr.all).toHaveLength(2);
  a.respond(201, ok("u1", "a.txt"));
  expect(FakeXhr.all).toHaveLength(3);
  expect(lastXhr().headers["x-upload-name"]).toBe("b.txt");
});

test("a 429 with nothing of ours in flight retries after a pause, and gives up after a few tries", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const s = createUploadStore("dev");
  s.add([file("a.txt")]);
  const busy = { error: { code: "too_many_uploads", message: "Too many uploads at once." } };
  for (let i = 0; i < 3; i++) {
    lastXhr().respond(429, busy);
    expect(s.get(s.keys()[0] as string)?.status).toBe("uploading");
    vi.advanceTimersByTime(1000);
  }
  expect(FakeXhr.all).toHaveLength(4);
  lastXhr().respond(429, busy);
  expect(s.get(s.keys()[0] as string)).toMatchObject({ status: "failed", retryable: true });
  vi.useRealTimers();
});
