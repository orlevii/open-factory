# T-1 Accept any file type in chat uploads: Technical Design

Task: factory task T-1, written by the CPO and scoped with Or. Amends the U3 chat design §13.5 "Types" (`2026-11-21-u3-chat-design.md`), and DESIGN.md "Attachments" (§4 below). Pre-release (ADR 0028): no compatibility shims and no migration.

The decisions were settled with Or's proxy on 2026-11-27 (Q1 to Q8, plus the tech lead's own calls, which the proxy reviewed), and the UI was reviewed by the designer, whose changes are folded into §3.5 and §4. The full decision log, with alternatives and certainties, is on the GitHub issue.

## 1. Why

Today a human can attach only PNG, JPEG, GIF, WebP and UTF-8 text to a message. Everything else is refused with 415 (`apps/server/src/uploads/sniff.ts`). Or needs to hand agents other files, a zip in particular. The agent side already treats an upload as a path on disk (`[attached: <path>]`), so the allowlist only protects the browser, and that protection can come from how a file is served instead of whether it is accepted.

## 2. Goals, non-goals, anti-goals

**Goals**
- Every non-empty file up to 20 MB is accepted: zip, PDF, SVG, HTML, HEIC, UTF-16 text, binaries, anything.
- Images and UTF-8 text keep their behaviour: inline image previews (auto up to 1 MB, "Show preview" above), header-only dimensions, and the 8000 px / 50 MP limits on what is previewed.
- Everything else is an opaque **file**: a third `kind` alongside `image` and `text`. It is never previewed or rendered in the browser, and it is only ever served as a download.

**Non-goals** (out of scope): raising the 20 MB cap; attachments on task comments; agent → human or agent → agent files (the future "Artifacts" initiative); unpacking, scanning or inspecting file contents; zipping dropped folders; announcing a failed upload through the composer's note slot and live region (a pre-existing gap, Q8, tracked in its own follow-up issue).

**Anti-goals** (failure even if it "works")
- An uploaded HTML or SVG file renders in the factory's origin, in a tab or inline. This is the security boundary.
- The type is taken from the extension or the client's MIME type.
- The agent sees anything different from today.

## 3. Behaviour

### 3.1 Classification (server, `sniff.ts`)

The kind comes from the bytes alone. The file name is no longer an input to the sniff (Q1).

| Bytes | Kind | Served as |
|---|---|---|
| empty | refused, **422** "The file is empty." (`empty_file`) | — |
| PNG/JPEG/GIF/WebP magic **and** dimensions readable from the header **and** ≤ 8000 px a side **and** ≤ 50 MP | `image` (with `width`, `height`) | `image/*`, `inline` |
| valid UTF-8 (streaming check plus final flush), no NUL, not SVG or HTML by content | `text` | `text/plain; charset=utf-8`, `attachment` |
| anything else, including raster magic that fails the dimension or limit checks (Q2), SVG or HTML by content, HEIC, UTF-16, PDF, zip, invalid UTF-8, bytes with a NUL | `file` | `application/octet-stream`, `attachment` |

- The SVG/HTML content rules are today's: after an optional BOM and leading whitespace, a `<svg`, a `<!doctype svg`, an `<?xml` whose first 4 KB contain `<svg`, or the WHATWG unambiguous-HTML start tags (`HTML_START`). They now return `file` instead of refusing.
- A leading `%PDF-` is a `file` (a byte rule, kept from today). A minimal, all-ASCII PDF is valid UTF-8, and without this rule it would be labelled text. *(Tech lead's call.)*
- The rules that only refused (`HEIC`, `UTF16`, `SVG_EXT`, `HTML_EXT`, `NO_SIZE`, `IMAGE_TOO_LARGE`, `UNSUPPORTED`) are deleted along with their copy. HEIC (its `ftyp` box starts with a big-endian length, so it has a NUL) and UTF-16 (a BOM that is invalid UTF-8, or NULs) become `file` by falling through.
- `Sniffed` becomes `image | text | { kind: "file"; mime: "application/octet-stream" }`. `Refusal` becomes `{ status: 422; reason: string }` (the empty file only). The route's `refusalCode` collapses to `empty_file`, and the `unsupported_type` and `image_too_large` codes are gone.
- `Sniffer` keeps the head and the streaming UTF-8 check as today. `finish()` loses its `name` parameter, and `sniffType(data)` likewise.
- The sniff is deterministic on the bytes, so `UploadService.read()` re-sniffs name-free as today and compares the result with the stored `kind`. A mismatch is still 409 `upload_changed`.

**Accepted limitation (recorded so it isn't reopened without new information):** a polyglot with a valid, in-limit raster header and HTML after it is an `image` and is served `inline` as `image/*`. With `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`, a browser treats it only as an image and never runs it as a document. This is today's behaviour.

### 3.2 Serving (`GET /api/agents/:ref/uploads/:id`)

No new route and no new branch. `read()` returns the sniffed `mime`, which is now `application/octet-stream` for a file, and the route already sends every non-image as `attachment`. The response headers for each kind:

- every kind: `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: private, no-store`
- image: `Content-Type: image/*`, `Content-Disposition: inline; filename=…; filename*=…`
- text: `Content-Type: text/plain; charset=utf-8`, `Content-Disposition: attachment; …`
- file: `Content-Type: application/octet-stream`, `Content-Disposition: attachment; …`

Access, the size and sha256 check, `gone` and `changed` are all unchanged.

### 3.3 Types end to end

`"file"` joins the union in `packages/db` (`uploads.kind` `$type`), `UploadInfo` (`service.ts`) and `messageAttachmentSchema.kind` (`packages/shared/src/messaging.ts`). `uploads.kind` is untyped `text` with no CHECK constraint, so there is **no migration**. `width`/`height` stay null for `text` and `file`.

### 3.4 Agent side

Unchanged. The file is stored at `.factory/uploads/<yyyymmdd>-<id>-<safe>` with its extension kept by `safeUploadName`, and the agent's body gets the same `[attached: <path>]` line, with no hint about the kind.

### 3.5 Web

**One chip anatomy** for the message chip and the composer chip (designer review; Q3, Q7):
- **Leading slot:** a fixed 28px box. It holds a 28px thumbnail or a 16px icon centred in the box. The slot never changes size, so nothing moves when a thumbnail arrives, is dropped, or "Show preview" is pressed. A swap happens with no transition.
- **Text column, line 1:** the name, 13px, `MiddleTruncate` with `keepEnd` so the extension stays visible, and `dir="auto"`.
- **Text column, line 2:** 12px, muted, `tabular-nums`, `dir="ltr"`, nowrap and never truncated. It shows the size, or in the composer the status (see below). Only the name shrinks.
- **Height:** two 16px lines fit the existing 36px chip, which is `min-h-9`, not `h-9`, so it grows at 200% text instead of clipping. The width cap stays at `max-w-[12rem]`.
- **Icons:** `ImageIcon` for an image without a preview, `FileText` for text, and a generic lucide `File` for a file. There is no icon by extension. All icons are `aria-hidden`.

**Message chips** (`AttachmentChip` in `features/session/message-block.tsx`). One component renders chat, the session timeline and the queue.
- Line 2 is the size, for every kind.
- An image previews automatically up to 1 MB. Above that it shows `ImageIcon`, and the "Show preview" button stays outside the chip as today; pressing it puts the thumbnail into the same slot.
- **Click:** an image chip keeps `target="_blank" rel="noopener noreferrer"`. **Every non-image chip (text and file) is `<a href download>`** with no `target`, so it saves at once and never flashes a blank tab (Q4). The server's `attachment` header is the real guarantee; `download` only makes the client agree with it.
- **Accessible name:** a visually hidden "Download " prefix on non-image chips and "Open " on image chips, so a screen reader hears "Download a.zip, 1.2 MB". Fine pointers also get `title="Download <name>"` (or "Open <name>").
- Hover and focus keep today's `hover:border-ring` and focus ring; there is no extra download icon.
- On coarse pointers the chip link gets the `hit-touch` 40px expander. The chip list is `flex-wrap` with a 6px gap and never scrolls sideways.

**Composer chip** (`UploadChip` in `components/composer/attachments.tsx`, state in `features/session/uploads.ts`) (Q5):
- **Line 2 is never blank.** It shows the size (the local `File.size`) from the moment the file is added. While uploading it shows only the percentage, alongside the existing 2px bar; on failure it shows the reason; once uploaded, the size returns.
- A failed chip still grows to show its reason on up to two lines, as today (D13). *(Tech lead's call.)*
- **Accessible name:** the `<li>` is named "<name>, <size>, <status>" (for example "report.zip, 1.2 MB, uploaded"). The existing Retry, Cancel and Remove labels stay.
- **Leading slot:** a local thumbnail is made only for the four raster MIME types (`IMAGE_TYPES`, a local `createImageBitmap` of the user's own file, never SVG). Without one, the slot shows `File` until the server answers, and `FileText` only once the server says `kind: "text"`, because the client doesn't guess the kind. If the server answers `kind: "file"` for something the client thumbnailed (an over-limit PNG), the bitmap is closed and dropped and the slot shows `File`.
- The client-side refusals are unchanged: empty, and over 20 MB.

**Size formatting** (Q6, **its own commit** with its own edge tests). `formatBytes` (`features/session/format.ts`) is fixed for every caller:
- Binary math (1024) with `KB`/`MB` labels, so it agrees with `MAX_UPLOAD_BYTES = 20 * 1024 * 1024` and the "larger than 20 MB" copy.
- `N B` under 1024 bytes; whole `KB` below 1 MiB, except that a value that would round to 1024 KB reads "1.0 MB" instead; one decimal in `MB` from there on.
- A no-break space between the number and the unit, so the size can never wrap.
- Test cases: 999 B, 1023 → "1023 B", 1024 → "1 KB", 1,048,575 → "1.0 MB" (never "1024 KB"), and just under 20 MiB → "20.0 MB" (never "21.0 MB").
- The activity line keeps its "from 1 KB on" gate; only its comment, which claims `formatBytes` would read "0 KB", is fixed.

## 4. DESIGN.md amendment

In the **Attachments** bullet, after "A drop target … with no animation.", add (designer's wording, agreed with the proxy):

> Every file chip, in a composer and in a message, has one anatomy: a 28px leading slot (a thumbnail, or a 16px icon centred in it), then the name over the size. The name middle-truncates and keeps its extension; the size is a muted tabular 12px line that never truncates, and a transfer's percentage or a failure's reason takes its place until the file is done. The slot and the chip's height never change between states. Only an image previews or opens in a new tab; any other file, text included, is a download link that names itself "Download …" to assistive tech, with a generic file icon unless the server says it is text.

The existing sentence about auto-previewing images up to 1 MB stays. The U3 spec's §13.5 "Types" bullet is superseded by §3.1 here; add a one-line pointer to this spec beside it.

## 5. Approaches considered

- **Chosen: a third `kind: "file"` end to end, with one GET route.** The serving rule ("only images are inline") already exists, and only the mime for the new kind is new.
- **A separate `/download` route for opaque files.** Rejected: a second serving path that has to stay equally safe, when the existing route already sends every non-image as an attachment.
- **Serving every non-image, text included, as octet-stream.** Rejected: the brief keeps text's behaviour, and `text/plain` with `nosniff` is already never rendered.
- **Storing the client-declared MIME for display or for the agent.** Rejected: the brief says the type comes from the bytes only.
- **(Classification) Extension demotes text to file** (Q1b). Rejected: it adds an input that has to flow into `read()`, and the same bytes would get a different kind depending on the name. Text and file are both attachments, so it buys no safety.

## 6. Tests (per AGENTS.md "Testing standards")

**Security boundary: one table-driven route test** through the real `POST` then `GET` against Postgres. The inputs: an HTML document; an SVG; `<?xml …><svg …>`; an HTML document named `x.png`; an HTML document named `a.html`. Every request is `Content-Type: application/octet-stream`, which is what the web client always sends. The route's existing 415 `unsupported_media_type` for any other request body type is unchanged and stays (it is about the request encoding, not the file). *(Tech lead's call.)* Each one must come back `201` with `kind: "file"`, and its `GET` must have `Content-Type: application/octet-stream`, `Content-Disposition: attachment…`, `X-Content-Type-Options: nosniff` and the sandbox CSP, and never `inline`.

**Sniff unit tests** (`sniff.test.ts`, `test.each`):
- zip (`PK\x03\x04`), PDF, HEIC `ftyp`, UTF-16 with a BOM, bytes with a NUL, invalid UTF-8, and a truncated multibyte end are all `file`.
- SVG/HTML by content are `file`, and the same bytes give the same kind regardless of name, since `finish()` takes no name.
- Raster magic with unreadable dimensions, a zero side, over 8000 px a side, over 50 MP, and HTML after a GIF magic header with no readable descriptor are all `file`.
- In-limit images keep their dimensions (the existing tests stay), and plain UTF-8 stays `text`.
- Empty stays 422.

**Route tests** (`routes/uploads.test.ts`):
- A zip and a PDF upload; the `[attached: path]` reaches the agent; the bytes on disk equal the upload (sha256), checked once via the existing send flow.
- The GET of an image stays `inline` with `image/*`, and text stays `attachment` with `text/plain`.
- Delete the 415 `unsupported_type` and 422 `image_too_large` tests (no tombstones). An over-limit PNG is covered by the sniff test, plus one route assertion that it is `201` `file` and downloads as octet-stream.

**Web tests:**
- An `AttachmentChip` for a file is a link named "Download <name>, <size>", with `download` and no `target`, and it never has an `<img>`.
- A text chip has `download`; an image chip is named "Open …" and keeps `target=_blank` and its preview and "Show preview" behaviour.
- The composer chip's accessible name and second line give the size before and after the upload, and the percentage during it; its icon is `File` until the server says text.
- A server answer of `kind: "file"` for a PNG the client thumbnailed removes the thumbnail.
- The existing composer and `uploads.test.ts` tests that used a `415 unsupported_type` response as their "refused, not retryable" fixture switch to a 422 `empty_file` or a 413 response; the behaviour under test (Remove only, no Retry) is unchanged.
- `formatBytes` edges (§3.5).

## 7. Rollout

Pre-release; no migration and no flag. A browser tab still running the old bundle may fail to parse a `"file"` attachment until it reloads. The PR's rollout notes say so in one line.

## 8. Left to the builder

- Whether `ImageMime`/`TEXT_MIME` and the new octet-stream constant live together as a `SniffedMime` type for `read()`'s return.
- Test fixture builders (a zip header, PDF bytes) in `uploads/fixtures.ts`.
