import { AgentStartError } from "../../agents/errors.ts";

/** dockerode's default when `DOCKER_HOST` isn't set. */
const DEFAULT_SOCKET = "/var/run/docker.sock";

/** Socket and network errors that mean the daemon wasn't reached at all (not an API answer). */
const UNREACHABLE = new Set([
  "ECONNREFUSED",
  "ENOENT",
  "EACCES",
  "EPERM",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
]);

export function dockerUnreachable(err: unknown): boolean {
  const e = err as { code?: unknown; statusCode?: unknown } | null;
  return (
    Boolean(e) &&
    e?.statusCode === undefined &&
    typeof e?.code === "string" &&
    UNREACHABLE.has(e.code)
  );
}

/**
 * A Docker failure on the start path as the start error the agent shows (spec §17): an unreachable daemon names
 * where it was looked for; any other Docker error keeps its own message. Start errors pass through unchanged.
 */
export function dockerStartError(err: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  if (err instanceof AgentStartError) return err;
  const message = (err instanceof Error ? err.message : String(err)).replace(/\.$/, "");
  if (dockerUnreachable(err))
    return new AgentStartError(
      `Can't reach Docker at ${env.DOCKER_HOST || DEFAULT_SOCKET}: ${message}.`,
    );
  if (err instanceof Error) return new AgentStartError(`Docker failed: ${message}`);
  return err;
}
