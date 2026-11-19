import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { deriveKey } from "./keys.ts";

const VERSION = 1;
export class VaultError extends Error {
  constructor(message = "Can't decrypt this value. Was FACTORY_SECRET_KEY changed?") {
    super(message);
    this.name = "VaultError";
  }
}

/** AES-256-GCM. Blob: [version 0x01][12-byte nonce][ciphertext][16-byte tag]. AAD binds a blob to its row. */
export class Vault {
  private readonly key: Buffer;
  constructor(rootKey: string) {
    this.key = deriveKey(rootKey, "secret-encryption");
  }
  seal(plaintext: string, aad: string): Buffer {
    const nonce = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, nonce);
    c.setAAD(Buffer.from(aad));
    const body = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return Buffer.concat([Buffer.from([VERSION]), nonce, body, c.getAuthTag()]);
  }
  open(blob: Buffer, aad: string): string {
    if (blob.length < 1 + 12 + 16 || blob[0] !== VERSION) throw new VaultError();
    try {
      const d = createDecipheriv("aes-256-gcm", this.key, blob.subarray(1, 13));
      d.setAAD(Buffer.from(aad));
      d.setAuthTag(blob.subarray(blob.length - 16));
      return Buffer.concat([d.update(blob.subarray(13, blob.length - 16)), d.final()]).toString(
        "utf8",
      );
    } catch {
      throw new VaultError();
    }
  }
}
