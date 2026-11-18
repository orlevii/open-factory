import { hkdfSync } from "node:crypto";

export type KeyPurpose = "better-auth" | "secret-encryption";
const SALT = "open-factory/v1";

/** The one place subkeys are derived from FACTORY_SECRET_KEY (HKDF-SHA256, 32 bytes). */
export function deriveKey(root: string, purpose: KeyPurpose): Buffer {
  return Buffer.from(hkdfSync("sha256", root, SALT, purpose, 32));
}

export function authSecret(root: string): string {
  return deriveKey(root, "better-auth").toString("base64url");
}
