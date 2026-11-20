declare module "tar-stream" {
  import type { Readable, Writable } from "node:stream";
  export interface Headers {
    name: string;
    size?: number;
    mode?: number;
    mtime?: Date;
    type?: string | null;
    linkname?: string | null;
  }
  export interface Pack extends Readable {
    /** Without a body: the returned stream takes exactly `header.size` bytes. */
    entry(header: Headers, callback?: (err?: Error | null) => void): Writable;
    entry(
      header: Headers,
      buffer?: string | Buffer,
      callback?: (err?: Error | null) => void,
    ): Writable;
    finalize(): void;
  }
  export interface Extract extends Writable {
    on(
      event: "entry",
      listener: (header: Headers, stream: Readable, next: () => void) => void,
    ): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }
  export function pack(): Pack;
  export function extract(): Extract;
  const tar: { pack: typeof pack; extract: typeof extract };
  export default tar;
}
