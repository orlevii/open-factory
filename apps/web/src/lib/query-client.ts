import { ApiError } from "@open-factory/shared";
import { type DefaultOptions, QueryClient } from "@tanstack/react-query";
import { ZodError } from "zod";

/** A 4xx won't change on retry (except 408 and 429, which are transient); a response that fails its
 *  schema won't either. Network errors and 5xx retry up to three times. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 3) return false;
  if (error instanceof ZodError) return false;
  if (
    error instanceof ApiError &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  )
    return false;
  return true;
}

/** One client for the app and the tests: the tests run the production defaults (pr76 R1). */
export function createQueryClient(overrides?: DefaultOptions): QueryClient {
  return new QueryClient({
    defaultOptions: {
      ...overrides,
      // Loader-prefetched data is fresh on mount; WebSocket events invalidate what changes on the server.
      queries: { staleTime: 30_000, retry: shouldRetry, ...overrides?.queries },
    },
  });
}
