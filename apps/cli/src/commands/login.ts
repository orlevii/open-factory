import { parseArgs } from "node:util";
import { ApiError, apiFetch, meSchema } from "@open-factory/shared";
import { guardedFetch } from "../client.ts";
import type { Io } from "../commands.ts";
import { readConfig, resolveTarget, writeConfig } from "../config-store.ts";

function isHttpUrl(s: string): boolean {
  try {
    const { protocol } = new URL(s);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function loginError(url: string, status: number, body: { code?: string; message?: string }) {
  if (body.code === "INVALID_EMAIL_OR_PASSWORD") return "Wrong email or password.";
  if (body.code === "INVALID_ORIGIN")
    return `Login failed: the server does not accept ${new URL(url).origin}. Log in with the server's PUBLIC_URL.`;
  return `Login failed: ${body.message ?? status}`;
}

export async function login(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({ args, options: { url: { type: "string" } } });
  const cfg = await readConfig(io.env);
  const url = (values.url ?? (await io.ask("Server URL", resolveTarget(io.env, cfg).url))).replace(
    /\/$/,
    "",
  );
  if (!isHttpUrl(url)) {
    io.err(`Invalid server URL "${url}": use a full URL starting with http:// or https://`);
    return 1;
  }
  const email = await io.ask("Email");
  const password = await io.askHidden("Password");
  const f = guardedFetch(io.fetch, url);
  const res = await f(`${url}/api/auth/sign-in/email`, {
    method: "POST",
    // Node's fetch always sends `sec-fetch-mode: cors`, so better-auth's CSRF check demands a
    // trusted Origin on sign-in. The CLI is not a browser; it names the server it talks to.
    headers: { "content-type": "application/json", origin: new URL(url).origin },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
    io.err(loginError(url, res.status, body));
    return 1;
  }
  // The bearer plugin exposes the session token in this header.
  const token = res.headers.get("set-auth-token");
  if (!token) {
    io.err("Login failed: server did not return a token.");
    return 1;
  }
  try {
    const me = await apiFetch("/api/me", { baseUrl: url, token, schema: meSchema, fetchImpl: f });
    await writeConfig(io.env, { url, token });
    io.out(`Logged in as @${me.handle}`);
    return 0;
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    io.err(`Login failed: ${e.message}`);
    return 1;
  }
}
