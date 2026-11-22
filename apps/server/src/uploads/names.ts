/** U3 §13.5: the `safe` part of a stored upload name is at most this many bytes (ASCII, so characters). */
export const MAX_SAFE_NAME_BYTES = 80;
/** An extension is kept only when it is short and alphanumeric (`.png`, `.json`, `.tsx`). */
const EXT = /\.([A-Za-z0-9]{1,16})$/;

/**
 * The file-system-safe form of an uploaded file's name: NFC first, then every character outside `[A-Za-z0-9._-]`
 * becomes `-` (one per code point, so U+202E, `]`, `/` and an NFC `é` each become one `-`), dot runs collapse to one
 * dot and leading dots go (no `..`, no hidden files), capped at 80 bytes with the extension kept. Never empty.
 */
export function safeUploadName(original: string): string {
  let s = Array.from(original.normalize("NFC"), (ch) => (/^[A-Za-z0-9._-]$/.test(ch) ? ch : "-"))
    .join("")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+/, "");
  if (!s) return "file";
  if (s.length > MAX_SAFE_NAME_BYTES) {
    const ext = EXT.exec(s)?.[0] ?? "";
    const base = s.slice(0, s.length - ext.length);
    // A cut that ends on a dot would make `..` with the extension's dot.
    s = base.slice(0, MAX_SAFE_NAME_BYTES - ext.length).replace(/\.+$/, "") + ext;
  }
  return s;
}

/** `<yyyymmdd>-<id>-<safe>` (UTC date). */
export function storedUploadName(at: Date, id: string, original: string): string {
  const day = at.toISOString().slice(0, 10).replaceAll("-", "");
  return `${day}-${id}-${safeUploadName(original)}`;
}
