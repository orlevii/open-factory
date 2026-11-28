# T-1 Accept Any File Type in Chat Uploads: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any non-empty file up to 20 MB can be attached in chat. Images and UTF-8 text behave as before. Everything else is an opaque `file` that is only ever served as an `application/octet-stream` attachment.

**Architecture:** The sniff (`apps/server/src/uploads/sniff.ts`) stops refusing and returns a third `kind: "file"` with mime `application/octet-stream`. The existing GET route already serves every non-image as `attachment` with the sniffed mime, so serving needs no new branch. `"file"` is typed end to end (db `$type`, `UploadInfo`, shared zod). On the web, both chips share one presentational anatomy (a 28px leading slot, then the name over a second line). Message chips split into two explicit variants: an image chip that opens in a tab, and a download chip.

**Tech Stack:** Fastify + Drizzle/Postgres (server), Vitest (server tests against real Postgres via `makeTestApp`), React 19 + Testing Library/jsdom (web), zod (`@open-factory/shared`), lucide-react icons.

**Spec:** `docs/superpowers/specs/2026-11-27-t1-uploads-any-file-type-design.md`. Read it with this plan; the section numbers below (§3.1…) refer to it.

## Global Constraints

- The kind comes from the bytes only. `Sniffer.finish()` and `sniffType()` take **no name**. The extension and the client MIME type are never inputs.
- Kinds: `"image" | "text" | "file"`. File mime: `"application/octet-stream"`.
- The only refusal left: an empty file, `422`, reason `"The file is empty."`, code `empty_file`. The codes `unsupported_type` and `image_too_large`, and all the refusal copy that went with them, are deleted. No shims, no tombstone tests (AGENTS.md, ADR 0028).
- Every GET keeps `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox` and `Cache-Control: private, no-store`. Only `kind === "image"` is `inline`.
- The route's 415 `unsupported_media_type` for a request body that isn't `application/octet-stream` stays.
- Limits are unchanged: `MAX_UPLOAD_BYTES = 20 * 1024 * 1024`, 10 files per message, `MAX_IMAGE_SIDE = 8000`, `MAX_IMAGE_PIXELS = 50_000_000` (these now decide `image` versus `file`, never a refusal).
- The agent side is unchanged: the same `[attached: <storedPath>]` line, the same stored path.
- No DB migration (`uploads.kind` is untyped `text`).
- Web: no CSS-class assertions in tests (AGENTS.md); assert roles, accessible names, text and attributes. Icons are `aria-hidden`.
- Size text uses `formatBytes` (Task 1), with a no-break space (` `) before the unit.
- The touch expander utility is the existing `.hit-40` class (`apps/web/src/styles.css`; DESIGN.md calls the token `hit-touch`). It needs a positioned element (`relative`).

## Review Focus

1. **A NUL or invalid UTF-8 byte far past the 512 KB head** must still make the file `file`, not `text`, because the UTF-8 check streams over every chunk. Test in Task 2.
2. **A BOM plus whitespace before `<!doctype html>` or `<svg`** must be `file`, so the BOM strip and `trimStart` still apply. Test in Task 2.
3. **Raster magic that becomes `file`** (an over-limit PNG) must download as octet-stream and never be `inline`. The disposition keys off `row.kind`, not the magic. Test in Task 2.
4. **A retried composer upload** must go from the reason back to the percentage, then to the size, and the second line is never blank. Test in Task 5.
5. **A file at exactly the 20 MiB cap** must read "20.0 MB" on its chip. Test in Task 1.

---

### Task 1: `formatBytes` uses binary units, `N B` and a no-break space

Its own commit (spec §3.5 "Size formatting").

**Files:**
- Modify: `apps/web/src/features/session/format.ts` (`formatBytes`)
- Modify: `apps/web/src/features/session/activity-line.tsx:206` (comment only)
- Test: `apps/web/src/features/session/format.test.ts` (the `"bytes"` test)
- Update expectations: `apps/web/src/features/session/activity-line.test.tsx` (lines ~172–245: `"12 KB"`, `"32 KB"`, `"40 KB"`, `"2 KB"`, `"1 KB"`), `apps/web/src/features/session/tools/bash.test.tsx:105` (`"Binary output · 14 KB · show raw"`)

**Interfaces:**
- Produces: `formatBytes(n: number): string`. Under 1024 it gives `` `${n} B` ``. Below 1 MiB it gives `` `${Math.round(n / 1024)} KB` ``, unless that rounds to 1024, in which case it falls through to MB. Otherwise it gives `` `${(n / 1048576).toFixed(1)} MB` ``.

- [ ] **Step 1: Replace the `"bytes"` test with `test.each` over the edges**

```ts
test.each([
  [999, "999 B"],
  [1023, "1023 B"],
  [1024, "1 KB"],
  [70_000, "68 KB"],
  [1_048_575, "1.0 MB"], // never "1024 KB"
  [1_200_000, "1.1 MB"],
  [20 * 1024 * 1024 - 1, "20.0 MB"], // never "21.0 MB"
  [20 * 1024 * 1024, "20.0 MB"],
])("formatBytes(%i) is %s", (n, out) => expect(formatBytes(n)).toBe(out));
```

- [ ] **Step 2: Run it and see it fail.** `pnpm test:related apps/web/src/features/session/format.ts`. Expect failures on every row (the old output is decimal, with a plain space).
- [ ] **Step 3: Implement `formatBytes`** as specified under Interfaces.
- [ ] **Step 4: Update the caller tests' expected strings** to the new output.
  - Compute each from the bytes the test feeds (12_000 → `12 KB`, 32_000 → `31 KB`, 40_000 → `39 KB`, 2000 → `2 KB`, 14_000 → `14 KB`).
  - The activity line's gate stays `>= 1000`. Its "1 KB" test feeds a byte count; recompute it (1000 → `1000 B`). If that reads wrong next to the gate's purpose, raise it in review; don't change the gate (spec: "keeps its gate").
  - Fix the comment at `activity-line.tsx:206` so it no longer claims `formatBytes` would read "0 KB". It now reads "under 1 KB the counter is noise, so it's hidden".
- [ ] **Step 5: Run.** `pnpm test:related apps/web/src/features/session/format.ts`, expecting PASS (format, activity-line, bash and any other importer).
- [ ] **Step 6: Commit.** `fix(web): formatBytes uses binary units, bytes under 1 KB and a no-break space`

---

### Task 2: Server: every file is accepted; opaque files are `kind: "file"` and download as octet-stream

**Files:**
- Modify: `apps/server/src/uploads/sniff.ts`
- Modify: `apps/server/src/uploads/store.ts:187` (`sniffer.finish()` with no name)
- Modify: `apps/server/src/uploads/service.ts` (`UploadInfo.kind`, the `read()` return type)
- Modify: `apps/server/src/routes/uploads.ts` (`refusalCode`, the `IMAGE_TOO_LARGE` import)
- Modify: `packages/db/src/schema/agents.ts:309` (`$type<"image" | "text" | "file">()`)
- Modify: `packages/shared/src/messaging.ts:43` (`kind: z.enum(["image", "text", "file"])`)
- Modify: `apps/server/src/uploads/fixtures.ts` (add `zip()` and `pdf()`)
- Test: `apps/server/src/uploads/sniff.test.ts`, `apps/server/src/uploads/store.test.ts:151-157`, `apps/server/src/routes/uploads.test.ts`, `apps/server/src/routes/agents.test.ts:1154` (the send flow)

**Interfaces:**
- Produces (`sniff.ts`):
  - `export const FILE_MIME = "application/octet-stream";`
  - `export type Sniffed = { kind: "image"; mime: ImageMime; width: number; height: number } | { kind: "text"; mime: typeof TEXT_MIME } | { kind: "file"; mime: typeof FILE_MIME };`
  - `export type Refusal = { status: 422; reason: string };`
  - `Sniffer.finish(): Sniffed | Refusal`
  - `sniffType(data: Buffer): Sniffed | Refusal`
  - `imageDimensions` is unchanged.
  - Deleted: `IMAGE_TOO_LARGE`, and the private `UNSUPPORTED`, `SVG`, `HTML`, `HEIC`, `UTF16`, `NO_SIZE`, `SVG_EXT`, `HTML_EXT`, `HEIF_BRANDS` and `extOf`.
- Produces (`service.ts`):
  - `UploadInfo.kind: MessageAttachment["kind"]`
  - `read()` resolves to `{ data: Buffer; mime: Sniffed["mime"] } | "gone" | "changed"`.
- Produces (`fixtures.ts`):
  - `zip(): Buffer`: a minimal empty-archive end-of-central-directory record (`PK\x05\x06` plus 18 zero bytes), or a local header `PK\x03\x04…`. It must contain a NUL.
  - `pdf(): Buffer`: `Buffer.from("%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n")`. It is all ASCII on purpose, so it exercises the `%PDF-` rule.

`finish()` decides in this order (spec §3.1):
1. Empty → 422.
2. Raster magic, with dimensions readable, both ≥ 1 and within the limits → `image`. Raster magic that fails any of those → `file`.
3. `%PDF-` at offset 0 → `file`.
4. A NUL, invalid UTF-8, or a failed final `decoder.decode()` flush → `file`.
5. The SVG/HTML content rules on the BOM-stripped, `trimStart`ed first 4 KB → `file`.
6. Otherwise → `text`.

- [ ] **Step 1: Rewrite the refusal tests in `sniff.test.ts` as `file` tests.**
  - Delete "SVG, HTML, HEIC, UTF-16, PDF, binary and invalid UTF-8 are refused with 415", "over 8000 px … is 422", "an image whose dimensions can't be read is refused" and the over-cap half of "review m2". Add:

```ts
const FILE = { kind: "file", mime: "application/octet-stream" };
test.each([
  ["a zip", zip()],
  ["an all-ASCII PDF", pdf()],
  ["HEIC", heic()],
  ["UTF-16 with a BOM", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hi", "utf16le")])],
  ["UTF-16 without a BOM", Buffer.from("hi", "utf16le")],
  ["bytes with a NUL", Buffer.from([0x00, 0x01, 0x02, 0x03])],
  ["invalid UTF-8", Buffer.from([0x61, 0xc3, 0x28])],
  ["a truncated multibyte end", Buffer.from([0x61, 0xe2, 0x9c])],
  ["SVG", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
  ["SVG behind <?xml", Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>')],
  ["SVG after whitespace", Buffer.from("  <svg onload=alert(1)>")],
  ["an HTML document", Buffer.from("<!DOCTYPE html><html><script>x</script>")],
  ["HTML after a BOM and newlines", Buffer.from("﻿\n\n<!doctype html><p>x")],
  ["a PNG with an unreadable header", png(10, 10).subarray(0, 18)],
  ["a JPEG with no frame header", Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
  ["a PNG with a zero side", png(0, 10)],
  ["a PNG over 8000 px a side", png(8001, 10)],
  ["a PNG over 50 MP", png(8000, 8000)],
  ["a JPEG over 8000 px", jpeg(9000, 100)],
  ["a WebP over 8000 px", webp(16000, 10)],
  ["a GIF frame over the caps", gifWithFrame(10, 10, 30000, 30000)],
  ["HTML behind a GIF magic header", Buffer.concat([Buffer.from("GIF89a"), Buffer.from("<html><script>x</script>")])],
])("%s is an opaque file", (_, data) => expect(sniffType(data)).toEqual(FILE));
```

  - Keep `png(8000, 6000)` and `gifWithFrame(10, 10, 20, 30)` as `image` assertions.
  - Replace "the extension is not trusted" with: "the same bytes get the same kind whatever they're called". `sniffType` takes no name, so assert that `png(10,10)` is `image`, `"hello\n"` is `text` and the SVG bytes are `file` (this one test covers the end-to-end name case in the route test).
  - Add the **Review Focus 1** test:

```ts
test("a NUL far past the head still makes it a file", () => {
  const s = new Sniffer();
  s.push(Buffer.alloc(600 * 1024, 0x61));
  s.push(Buffer.from([0x00]));
  expect(s.finish()).toEqual(FILE);
});
```

- [ ] **Step 2: Run and see the new tests fail.** `pnpm test:related apps/server/src/uploads/sniff.ts`. Expect FAIL (currently `{status: 415}`/`422`).
- [ ] **Step 3: Implement `sniff.ts`** to the Interfaces and the decision order above.
  - Drop the `name` parameter.
  - Update the header comment: the kind is read from the bytes; everything that isn't an in-limit image or plain UTF-8 text is an opaque file.
- [ ] **Step 4: Widen the types.** This covers `packages/db` `$type`, `messageAttachmentSchema.kind`, `UploadInfo.kind` and `read()`'s mime.
  - In `store.ts`, call `sniffer.finish()` with no argument and keep `o.name` only for what it's still used for, if anything; delete it from the options type if nothing uses it.
  - In `routes/uploads.ts`, `refusalCode` becomes the constant `"empty_file"`: inline it and delete the function and the `IMAGE_TOO_LARGE` import.
- [ ] **Step 5: Run the sniff and store tests.** `pnpm test:related apps/server/src/uploads/sniff.ts`, expecting PASS. Fix `store.test.ts` "a refused type returns the refusal and leaves no file" so it feeds `Buffer.alloc(0)` (an empty file, `{status: 422}`), and rename it "an empty file returns the refusal and leaves no file".
- [ ] **Step 6: Write the route tests (`routes/uploads.test.ts`).**
  - Delete "SVG, HTML, HEIC and UTF-16 are 415 with a reason; nothing is kept" and "a 30000×30000 PNG header is 422 without decoding". Import `zip` and `pdf` from fixtures.
  - Add the **security-boundary** test, one `test.each` (spec §6):

```ts
test.each([
  ["an HTML document", Buffer.from("<!doctype html><html><body><script>alert(1)</script>"), "page.html"],
  ["an SVG", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), "icon.svg"],
  ["an SVG behind <?xml", Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'), "a.svg"],
  ["HTML named like an image", Buffer.from("<html><script>alert(1)</script>"), "x.png"],
  ["HTML named a.html", Buffer.from("<!DOCTYPE html><p>hi"), "a.html"],
  ["a PNG over the image limits", png(30000, 30000), "huge.png"], // Review Focus 3
])("%s is accepted as a file and only ever downloads as octet-stream", async (_, data, name) => {
  const res = await upload("ops", data, name);
  expect(res.statusCode).toBe(201);
  expect(res.json()).toMatchObject({ kind: "file", bytes: data.length, name });
  expect(res.json()).not.toHaveProperty("width");
  const got = await get("ops", res.json().uploadId);
  expect(got.statusCode).toBe(200);
  expect(got.headers["content-type"]).toBe("application/octet-stream");
  expect(String(got.headers["content-disposition"])).toMatch(/^attachment; /);
  expect(got.headers["x-content-type-options"]).toBe("nosniff");
  expect(got.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
  expect(got.rawPayload).toEqual(data);
});
```

  - Extend "a JPEG and UTF-8 text are accepted by content" with `[zip(), "a.zip", "file"]` and `[pdf(), "doc.pdf", "file"]`, and rename it "a JPEG, UTF-8 text, a zip and a PDF are accepted by content (sniff.test.ts owns every type)".
  - The existing "GET sends nosniff … text is an attachment" test already pins image `inline` and text `attachment`; leave it as it is.
- [ ] **Step 7: Extend the send flow (`agents.test.ts:1154`).** In "each file adds one [attached: …] line…", add a third upload, `zip()` named `"bundle.zip"`. Assert:
  - the body gains a third `[attached: <zipRow.storedPath>]` line;
  - `attachments` includes `{ uploadId, name: "bundle.zip", kind: "file", bytes }`, with no width or height;
  - `readFileSync(path.resolve(drv.last.spec.cwd, zipRel))` equals `zip()`, so the bytes on disk match the upload.
- [ ] **Step 8: Run.** `pnpm test:related apps/server/src/uploads/sniff.ts apps/server/src/routes/uploads.ts packages/shared/src/messaging.ts`, then `pnpm -w typecheck`. Expect all PASS.
- [ ] **Step 9: Commit.** `feat(server): accept any file type; opaque files download as octet-stream`

---

### Task 3: Web: one chip anatomy and the message chips

**Files:**
- Create: `apps/web/src/components/attachments/file-chip.tsx`, the shared presentational parts
- Create: `apps/web/src/features/session/attachment-list.tsx`. `AttachmentList`, the two chip variants, `uploadUrl` and `AUTO_PREVIEW_BYTES` move here out of `message-block.tsx`, which is 517 lines.
- Modify: `apps/web/src/features/session/message-block.tsx` (import `AttachmentList` from the new file; delete the moved code and the now-unused `FileText`/`ImageIcon` imports)
- Modify: `apps/web/src/features/chat/chat-row.tsx:13` (import `AttachmentList` from `@/features/session/attachment-list`)
- Test: `apps/web/src/features/session/attachment-list.test.tsx` (new, unit-level render of `AttachmentList`), plus the existing "an image over 1 MB previews only when asked" in `messaging.test.tsx:1394`, which stays as the wiring check

**Interfaces:**
- Produces (`file-chip.tsx`): composition, no boolean props.
  - `FileChipLead({ children }: { children: ReactNode })` is the fixed 28px slot (`size-7 shrink-0 grid place-items-center`). Children are a 28px thumbnail or a `KindIcon`.
  - `KindIcon({ kind }: { kind: MessageAttachment["kind"] | undefined })` renders `ImageIcon` for `"image"`, `FileText` for `"text"`, and `File` for `"file"` or `undefined`. It is 16px, `aria-hidden`.
  - `FileChipText({ name, children }: { name: string; children: ReactNode })` renders the column: line 1 is `<span dir="auto"><MiddleTruncate text={displayName(name)} keepEnd headMin /></span>` (13px); line 2 is `children`, the caller's second line.
  - `FileChipSize({ bytes }: { bytes: number })` renders line 2 as a size: `<span dir="ltr" data-size className="… text-xs tabular-nums whitespace-nowrap text-muted-foreground">{formatBytes(bytes)}</span>`.
  - `displayName` stays exported from `components/composer/attachments.tsx`; `file-chip.tsx` imports it.
- Produces (`attachment-list.tsx`):
  - `uploadUrl(agentRef, uploadId)` and `AUTO_PREVIEW_BYTES` are moved unchanged.
  - `AttachmentList({ agentRef, attachments })` is unchanged in signature. It renders `<ul aria-label="Attached files" className="mt-2 flex flex-wrap gap-1.5">` and, per item, `a.kind === "image" ? <ImageAttachmentChip …/> : <DownloadAttachmentChip …/>`.
  - `ImageAttachmentChip({ url, attachment })` holds the preview state (`small || asked`).
    - It renders `<a href target="_blank" rel="noopener noreferrer" title={`Open ${name}`}>` with `<span className="sr-only">Open </span>`, a lead (the 28px `<img>` or `KindIcon kind="image"`), and text with the size. Its "Show preview" button stays a sibling outside the link, as today.
  - `DownloadAttachmentChip({ url, attachment })` renders `<a href download title={`Download ${name}`}>` with no `target`, plus `<span className="sr-only">Download </span>`, a `KindIcon` for its kind, and text with the size. It never renders an `<img>`.
  - Both links are `relative hit-40 flex min-h-9 max-w-[12rem] …` with the existing border and `hover:border-ring` classes, and keep `data-attachment`.
- The accessible name comes out as "Download report.zip 1.2 MB". Assert it with a regex: `/^Download report\.zip\s+1\.2\sMB$/`.

- [ ] **Step 1: Write `attachment-list.test.tsx`.** Render `<AttachmentList agentRef="r1" attachments={[…]} />`.

```ts
test("a file chip is a download link named with its size, never a preview", () => {
  render(<AttachmentList agentRef="r1" attachments={[{ uploadId: "u1", name: "report.zip", kind: "file", bytes: 1_258_291 }]} />);
  const link = screen.getByRole("link", { name: /^Download report\.zip\s+1\.2\sMB$/ });
  expect(link).toHaveAttribute("download");
  expect(link).not.toHaveAttribute("target");
  expect(link).toHaveAttribute("href", "/api/agents/r1/uploads/u1");
  expect(link.querySelector("img")).toBeNull();
});
test("a text chip downloads too", () => {
  // kind "text", name "run.log", bytes 2048: the link is named /^Download run\.log\s+2\sKB$/, with `download` and no target
});
test("an image chip opens in a new tab and previews up to 1 MB, with its size", () => {
  // kind "image", bytes 500_000: the link is named /^Open shot\.png\s+488\sKB$/, target=_blank, rel=noopener noreferrer, one <img src=url>
});
test("an image over 1 MB shows its size and previews only when asked", async () => {
  // bytes 5_000_000: no <img>; the link name ends /4\.8\sMB$/; clicking "Show preview of big.png" adds one <img>; the link name is unchanged
});
test("an RTL name and the size are separate text runs", () => {
  // name "קובץ.zip": the name's span has dir="auto"; the [data-size] span has dir="ltr" and the text "1 KB"
});
```

- [ ] **Step 2: Run and see it fail.** `pnpm test:related apps/web/src/features/session/message-block.tsx` (or vitest on the new file). Expect FAIL: the module doesn't exist.
- [ ] **Step 3: Create `file-chip.tsx` and `attachment-list.tsx`** to the Interfaces. Then remove the moved code from `message-block.tsx`, and update `chat-row.tsx`'s import.
- [ ] **Step 4: Run.** `pnpm test:related apps/web/src/features/session/message-block.tsx apps/web/src/features/session/attachment-list.tsx`. Expect PASS, including `messaging.test.tsx` "an image over 1 MB previews only when asked" and the chat-view tests.
- [ ] **Step 5: Commit.** `feat(web): message chips show their size; non-image files download`

---

### Task 4: Web: the composer chip shows size, status and the server's kind

**Files:**
- Modify: `apps/web/src/components/composer/attachments.tsx` (`UploadView`, `UploadChip`; use `FileChipLead`, `KindIcon` and `FileChipText` from Task 3)
- Modify: `apps/web/src/features/session/uploads.ts` (`add`, the `onload` success path)
- Test: `apps/web/src/features/session/uploads.test.ts`, `apps/web/src/components/composer/composer.test.tsx`

**Interfaces:**
- Consumes: `FileChipLead`, `KindIcon`, `FileChipText` and `formatBytes` from Tasks 1 and 3.
- Produces (`UploadView`):
  - The `image: boolean` field is removed. Nothing outside the store reads it.
  - Added: `readonly kind?: MessageAttachment["kind"]`, which is unset until the server answers.
  - `thumb` is unchanged. The store makes it only when `IMAGE_TYPES.has(file.type)`.
- Produces (store `onload` success): `setView(k, { status: "done", progress: 1, kind: attachment.kind, ...(attachment.kind !== "image" ? { thumb: undefined } : {}) })`, after `e.view.thumb?.close()` when the kind isn't `image`. A late `createImageBitmap` resolution must also not set a thumb once `e.view.kind` is set and isn't `"image"`: check `entries.get(key) !== entry || (entry.view.kind && entry.view.kind !== "image")` and close the bitmap.
- `UploadChip`'s line 2:
  - `uploading` gives `` `${pct}%` ``;
  - `failed` gives the reason (`data-upload-error`, up to 2 lines as today);
  - otherwise `<FileChipSize bytes={v.bytes} />`.
- `UploadChip` accessible name: `<li aria-label={`${name}, ${formatBytes(v.bytes)}, ${status}`}>`, where status is `uploading ${pct}%`, `uploaded`, or `failed: ${v.error}`. The Retry, Cancel and Remove buttons keep their labels.
- `UploadChip`'s lead: `<FileChipLead>{v.thumb ? <Thumb bitmap={v.thumb} /> : <KindIcon kind={v.kind} />}</FileChipLead>`, so the icon is `File` until the server says `text`.
- Keep `memo` and the per-key `useSyncExternalStore` subscription (review m12): a progress tick renders only its own chip.

- [ ] **Step 1: Switch the 415 fixtures** (spec §6), keeping the behaviour each test is about.
  - `uploads.test.ts:87` "a refusal of the file shows the server's reason and offers no Retry": respond `422` `{ error: { code: "empty_file", message: "The file is empty." } }` for `a` and `413` `{ error: { code: "too_large", message: "The file is larger than 20 MB." } }` for `b`. Use plain names (`a.txt`, `b.bin`) instead of `p.heic`.
  - `composer.test.tsx:866`: respond `422` `empty_file` for the first file. Assert the chip shows "The file is empty." and has no Retry.
  - `composer.test.tsx:1141` "a failed chip's reason takes up to two lines": respond `413` with the 20 MB copy.
- [ ] **Step 2: Write the new store tests (`uploads.test.ts`).**

```ts
test("the server's kind lands on the view; a file answer drops the local thumbnail", async () => {
  // stub createImageBitmap to resolve a fake bitmap with a close spy; add file("big.png", 10, "image/png")
  // await the thumb; respond 201 { uploadId: "u1", name: "big.png", kind: "file", bytes: 10 }
  // expect(s.get(k)).toMatchObject({ status: "done", kind: "file" }); expect(s.get(k)?.thumb).toBeUndefined(); expect(close).toHaveBeenCalled()
});
test("a text answer keeps no thumbnail and records the kind", () => { /* file("a.txt") → 201 kind "text" → view.kind "text" */ });
```

- [ ] **Step 3: Write the composer chip tests (`composer.test.tsx`).**

```ts
test("a composer chip's second line is the size before and after the upload, the percentage during it", () => {
  // paste file("report.zip", 1_258_291); the chip (listitem) is named /^report\.zip, 1\.2\sMB, uploading 0%$/, and its text has "0%"
  // progress 50% → its text has "50%"; respond 201 kind "file" → named /^report\.zip, 1\.2\sMB, uploaded$/, its text has "1.2 MB" and no "%"
});
test("a retried upload goes from the reason to the percentage and back to the size", async () => {
  // Review Focus 4: respond 503 → the reason shows; click "Retry report.zip" → "0%"; respond 201 → the size; never an empty second line
});
test("the chip shows the generic file icon until the server says text", () => {
  // Assert via the lead's data attribute: KindIcon renders <svg data-kind-icon={kind ?? "file"}>
  // before the answer it is "file"; after 201 kind "text" it is "text"
});
```

  - Add `data-kind-icon` on the svg inside `KindIcon` for this test. It is not a styling assertion, and Task 3's tests may use it too.
- [ ] **Step 4: Run and see them fail.** `pnpm test:related apps/web/src/components/composer/attachments.tsx apps/web/src/features/session/uploads.ts`.
- [ ] **Step 5: Implement** `UploadView.kind`, the store changes and `UploadChip` to the Interfaces.
- [ ] **Step 6: Run.** The same command, expecting PASS (the composer, uploads, chat-view and messaging tests).
- [ ] **Step 7: Commit.** `feat(web): composer chips show size and status and follow the server's kind`

---

### Task 5: Docs: the DESIGN.md amendment and the U3 pointer

**Files:**
- Modify: `DESIGN.md:352` (the **Attachments** bullet)
- Modify: `docs/superpowers/specs/2026-11-21-u3-chat-design.md:488` (the "Types" bullet)

- [ ] **Step 1: Amend DESIGN.md.** Insert the spec §4 quoted paragraph verbatim after "…with no animation." in the Attachments bullet, and keep the 1 MB auto-preview sentence after it.
- [ ] **Step 2: Add the U3 pointer.** Append to the U3 "Types" bullet: ` *Superseded by T-1 (2026-11-27-t1-uploads-any-file-type-design.md §3.1): every non-empty file is accepted; non-image, non-text files are opaque downloads.*`
- [ ] **Step 3: Commit.** `chore(docs): DESIGN.md attachments chip anatomy; U3 types point to T-1`

---

### Task 6: Verify, then open the PR

- [ ] **Step 1:** Run `pnpm install --frozen-lockfile && pnpm -w typecheck && pnpm -w lint && pnpm test:fast && pnpm -w build`. All must pass. Then run the full `pnpm test` (with `DATABASE_URL` set) before pushing.
- [ ] **Step 2:** Check by hand in the running app (skill `run`), in a session with an agent:
  - Attach a zip, a PDF, an SVG and an HTML file, and send. The agent receives four `[attached: …]` lines.
  - `sha256sum` of each stored file under the agent's `.factory/uploads/` equals the original.
  - Each chip downloads; DevTools shows `application/octet-stream`, `attachment` and `nosniff`; nothing opens a tab.
  - A PNG under 1 MB still previews; a 5 MB PNG offers "Show preview"; a `.md` file downloads.
- [ ] **Step 3:** Push, then open a ready-for-review PR titled `feat: accept any file type in chat uploads`, filling every section of `.github/pull_request_template.md`.
  - What: link the spec and this plan.
  - Approach: one bullet per spec §5 decision.
  - Changes: grouped as server, shared/db, web and docs.
  - **Rollout:** "No migration. A browser tab still running the previous bundle may fail to read a message with a new `file` attachment until it reloads."
  - Link the T-1 GitHub issue.

---

## Notes for the executor

- `apps/web/src/features/session/uploads.ts` `errorOf` and `transient` are unchanged; 413 and 422 are still non-retryable.
- `UploadService.read()` already compares `s.kind !== r.kind`; with the name gone it is unchanged apart from its return type.
- Don't add an icon-by-extension map, a client MIME guess beyond `IMAGE_TYPES`, or a failure live-region announcement. The last is a non-goal with its own follow-up issue.
