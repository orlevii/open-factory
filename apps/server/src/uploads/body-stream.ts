/** Review m3: a request body that sends nothing for this long is abandoned (its temp file is deleted). */
export const UPLOAD_IDLE_MS = 30_000;

export class UploadIdleError extends Error {
  constructor() {
    super("The upload stalled; try again.");
    this.name = "UploadIdleError";
  }
}

/**
 * The request body as an iterable for the upload store:
 * - its early exit (over the cap, a refused write) doesn't destroy the request: a `for await` would call `return()`,
 *   which destroys the stream with an AbortError before the 413 is sent; the unread rest goes with the connection;
 * - a chunk that doesn't arrive within `idleMs` throws `UploadIdleError`, so a stalled client can't hold a slot.
 */
export function bodyStream(
  raw: AsyncIterable<Buffer>,
  idleMs = UPLOAD_IDLE_MS,
): AsyncIterable<Buffer> {
  return {
    [Symbol.asyncIterator]() {
      const it = raw[Symbol.asyncIterator]();
      return {
        next: () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const idle = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new UploadIdleError()), idleMs);
          });
          return Promise.race([it.next(), idle]).finally(() => clearTimeout(timer));
        },
      };
    },
  };
}
