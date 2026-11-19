import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HarnessDriver } from "@open-factory/harness";
import type { CredentialKind } from "@open-factory/shared";

export type VerifyResult =
  | { ok: true }
  | { ok: false; kind: "rejected" | "unreachable"; message: string };

const PROMPT = "Reply with the single word OK.";

/** Runs one tiny real turn with the credential under a throwaway config dir. The result carries
 *  fixed messages only: process output can echo the credential, so none of it is returned or logged. */
export class CredentialVerifier {
  constructor(
    private readonly d: {
      driver: HarnessDriver;
      claudeBin: string;
      serverEnv?: NodeJS.ProcessEnv;
      timeoutMs?: number;
    },
  ) {}

  async verify(kind: CredentialKind, value: string): Promise<VerifyResult> {
    const dir = await mkdtemp(path.join(tmpdir(), "of-verify-"));
    // Exactly PATH, HOME, CLAUDE_CONFIG_DIR and the credential variable. Nothing else from the server env.
    const env: Record<string, string> = {
      CLAUDE_CONFIG_DIR: dir,
      [kind === "api_key" ? "ANTHROPIC_API_KEY" : "CLAUDE_CODE_OAUTH_TOKEN"]: value,
    };
    const source = this.d.serverEnv ?? process.env;
    for (const k of ["PATH", "HOME"] as const) {
      const v = source[k];
      if (v) env[k] = v;
    }
    let code: string | undefined;
    let status: number | undefined;
    let ok = false;
    let timer: NodeJS.Timeout | undefined;
    const proc = this.d.driver.start(
      {
        agentId: "verify",
        slug: "verify",
        cwd: dir,
        env,
        claudeBin: this.d.claudeBin,
        runtime: "local",
        model: "haiku",
        permissionMode: "auto",
        mounts: [],
      },
      {},
    );
    const done = (async () => {
      for await (const e of proc.events) {
        if (e.type === "error" && e.code) code = e.code;
        if (e.type === "turn_end") {
          ok = !e.isError;
          status = e.apiErrorStatus;
          break;
        }
        if (e.type === "exited") break;
      }
    })();
    try {
      await proc
        .send([{ id: "verify", from: "@factory", kind: "message", urgent: false, body: PROMPT }])
        .catch(() => {});
      await Promise.race([
        done,
        new Promise((r) => {
          timer = setTimeout(r, this.d.timeoutMs ?? 60_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      await proc.stop({ graceMs: 1000, termWaitMs: 5000 }).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
    if (ok) return { ok: true };
    if (code === "authentication_failed" || status === 401 || status === 403)
      return {
        ok: false,
        kind: "rejected",
        message:
          kind === "api_key"
            ? "Claude rejected this API key."
            : "Claude rejected this token. Create a new one with `claude setup-token`.",
      };
    return {
      ok: false,
      kind: "unreachable",
      message: "Couldn't reach Claude to verify. Try again.",
    };
  }
}
