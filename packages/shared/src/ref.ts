/** Crockford base32, lowercase: no i, l, o, u, so a ref can't be misread (spec §4.2). */
export const REF_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export const REF_PATTERN = /^[0-9a-hjkmnp-tv-z]{8}$/;

/** The principal's ref: the UUID's last 5 bytes (random in a v4 UUID) as 8 base32 chars. */
export function refOf(uuid: string): string {
  let n = BigInt(`0x${uuid.replaceAll("-", "").slice(-10)}`);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out = REF_ALPHABET[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

/** A typed or copied ref, normalised (case; i/l → 1; o → 0), or undefined when it isn't one. */
export function normaliseRef(s: string): string | undefined {
  const r = s.toLowerCase().replaceAll(/[il]/g, "1").replaceAll("o", "0");
  return REF_PATTERN.test(r) ? r : undefined;
}
