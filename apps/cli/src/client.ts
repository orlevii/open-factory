import { ApiError } from "@open-factory/shared";

export class UnreachableError extends Error {}

/** Wraps fetch so network failures become UnreachableError (exit 1, plain message). */
export const guardedFetch =
  (f: typeof fetch, url: string): typeof fetch =>
  async (input, init) => {
    try {
      return await f(input, init);
    } catch {
      throw new UnreachableError(`Cannot reach server at ${url}`);
    }
  };

export const isUnauthorized = (e: unknown) => e instanceof ApiError && e.status === 401;
