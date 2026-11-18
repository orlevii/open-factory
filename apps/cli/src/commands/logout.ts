import { guardedFetch, UnreachableError } from "../client.ts";
import type { Io } from "../commands.ts";
import { readConfig, resolveTarget, writeConfig } from "../config-store.ts";

export async function logout(_args: string[], io: Io): Promise<number> {
  const cfg = await readConfig(io.env);
  const { url, token } = resolveTarget(io.env, cfg);
  if (token) {
    try {
      await guardedFetch(io.fetch, url)(`${url}/api/auth/sign-out`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}", // Fastify rejects an empty JSON body
      });
    } catch (e) {
      if (!(e instanceof UnreachableError)) throw e;
      io.err(`${e.message}; removed the local token anyway.`);
    }
  }
  await writeConfig(io.env, { url: cfg.url });
  io.out("Logged out");
  return 0;
}
