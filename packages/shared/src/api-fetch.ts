import type { z } from "zod";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** The whole parsed `error` object: extra fields such as `fields`, `currentHash`, `usedBy`, `output`. */
    public readonly body: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiFetchOptions<T> {
  baseUrl?: string;
  token?: string;
  method?: string;
  body?: unknown;
  schema: z.ZodType<T>;
  fetchImpl?: typeof fetch;
}

export async function apiFetch<T>(path: string, opts: ApiFetchOptions<T>): Promise<T> {
  const headers = new Headers();
  if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  const res = await (opts.fetchImpl ?? fetch)(`${opts.baseUrl ?? ""}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    credentials: "include",
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const d = data as
      | {
          error?: { code?: string; message?: string } & Record<string, unknown>;
          code?: string;
          message?: string;
        }
      | undefined;
    const code = d?.error?.code ?? d?.code ?? `http_${res.status}`;
    const message = d?.error?.message ?? d?.message ?? (res.statusText || `HTTP ${res.status}`);
    throw new ApiError(res.status, code, message, d?.error ?? {});
  }
  return opts.schema.parse(data);
}
