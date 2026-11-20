import type { BuildImageResult } from "./client.ts";

type BuildEvent = {
  stream?: unknown;
  status?: unknown;
  id?: unknown;
  progress?: unknown;
  error?: unknown;
  errorDetail?: { message?: unknown };
};

/**
 * Turns Docker build stream events into lines and a result. A failed build reports itself as an `error`/
 * `errorDetail` event while `followProgress` still completes with `err = null` (live gate V1 b, c), so the result
 * comes from the events. `stream` text may split a line across events; `end` flushes the rest.
 */
export function buildProgress(onLine: (line: string) => void) {
  let carry = "";
  let error: string | undefined;
  const emit = (text: string) => {
    const parts = (carry + text).split(/\r?\n/);
    carry = parts.pop() ?? "";
    for (const p of parts) onLine(p);
  };
  const flush = () => {
    if (carry) onLine(carry);
    carry = "";
  };
  return {
    push(raw: object) {
      const ev = raw as BuildEvent;
      if (typeof ev.stream === "string") emit(ev.stream);
      else if (typeof ev.status === "string" && ev.progress === undefined) {
        flush();
        onLine(typeof ev.id === "string" ? `${ev.id}: ${ev.status}` : ev.status);
      }
      const message = typeof ev.error === "string" ? ev.error : ev.errorDetail?.message;
      if (typeof message === "string") {
        flush();
        onLine(message);
        error ??= message;
      }
    },
    end(err: Error | null): BuildImageResult {
      flush();
      if (error !== undefined) return { ok: false, error };
      if (err) return { ok: false, error: err.message };
      return { ok: true };
    },
  };
}
