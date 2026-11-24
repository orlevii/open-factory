/** What a failed child process's output may carry into an event: the last 20 lines, at most 4 KB (its tail). */
export const OUTPUT_MAX_LINES = 20;
export const OUTPUT_MAX_BYTES = 4096;

export function capOutput(s: string): string {
  const lines = s.split("\n").filter((l) => l.trim());
  const text = lines.slice(-OUTPUT_MAX_LINES).join("\n");
  const bytes = Buffer.from(text);
  return bytes.length <= OUTPUT_MAX_BYTES
    ? text
    : bytes.subarray(bytes.length - OUTPUT_MAX_BYTES).toString();
}

/** The URL scheme is bounded and starts at a word boundary: an unbounded one backtracks quadratically on one long token. */
export function redactOutput(s: string): string {
  return s
    .replace(/(?<![a-z])([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/]*@/gi, "$1[redacted]@")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/\bglpat-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /\b((?:access_|refresh_|id_)?token|password|passwd|secret|api[_-]?key)=[^\s&'"]+/gi,
      "$1=[redacted]",
    );
}
