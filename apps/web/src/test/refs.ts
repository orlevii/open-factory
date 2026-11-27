import { REF_ALPHABET } from "@open-factory/shared";

/** A stable fake ref for a handle, in the real alphabet: fixtures name agents by handle, routes and caches by ref. */
export function refFor(handle: string): string {
  let h = 2166136261;
  for (const ch of handle) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  let out = "";
  for (let i = 0; i < 8; i++) {
    h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
    out += REF_ALPHABET[h % REF_ALPHABET.length];
  }
  return out;
}

/** A UUID whose `refOf` is `refFor(handle)`: a fixture user's id, so the ref the app derives from it is the one the test names. */
export function uuidFor(handle: string): string {
  let n = 0n;
  for (const ch of refFor(handle)) n = (n << 5n) | BigInt(REF_ALPHABET.indexOf(ch));
  return `00000000-0000-4000-8000-00${n.toString(16).padStart(10, "0")}`;
}

/** A fixture agent as the server mentions it: `<@ref|handle>`. */
export function mentionFor(handle: string): string {
  return `<@${refFor(handle)}|${handle}>`;
}
