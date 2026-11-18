import { apiFetch, meSchema, statusSchema } from "@open-factory/shared";
import { guardedFetch, isUnauthorized } from "../client.ts";
import { CLI_VERSION, type Io } from "../commands.ts";
import { readConfig, resolveTarget } from "../config-store.ts";

export async function status(_args: string[], io: Io): Promise<number> {
  const { url, token } = resolveTarget(io.env, await readConfig(io.env));
  const fetchImpl = guardedFetch(io.fetch, url);
  const s = await apiFetch("/api/status", { baseUrl: url, schema: statusSchema, fetchImpl });
  io.out(`Server: ${url}`);
  io.out(`Server version: ${s.version}`);
  io.out(`Database: ${s.db}`);
  io.out(`CLI version: ${CLI_VERSION}`);
  if (!token) {
    io.out("Not logged in");
    return 0;
  }
  try {
    const me = await apiFetch("/api/me", { baseUrl: url, token, schema: meSchema, fetchImpl });
    io.out(`Logged in as @${me.handle}`);
  } catch (e) {
    if (!isUnauthorized(e)) throw e;
    io.out("Not logged in");
  }
  return 0;
}
