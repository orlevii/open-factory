import { execFile } from "node:child_process";
import { checkClaudeVersion, compareVersions, MIN_CLAUDE_VERSION } from "@open-factory/harness";
import { capOutput, redactOutput } from "../redact.ts";
import { SECURITY_OPT } from "../runtime/docker/spec-hash.ts";

/** `claude --version` runs on the host, so it never gets the agent's env or its agent-writable
 *  `CLAUDE_CONFIG_DIR`: only `PATH` and the host `HOME`. */
export function versionCheckEnv(serverEnv: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  if (serverEnv.PATH) env.PATH = serverEnv.PATH;
  if (serverEnv.HOME) env.HOME = serverEnv.HOME;
  return env;
}

/** The variables the docker CLI reads to find its daemon: the ones the Docker client of the runtime honours too. */
const DOCKER_ENV = [
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
] as const;

/** `PATH`, `HOME` and the docker daemon variables of the server's env; nothing else. */
export function dockerCheckEnv(serverEnv: NodeJS.ProcessEnv): Record<string, string> {
  const env = versionCheckEnv(serverEnv);
  for (const k of DOCKER_ENV) {
    const v = serverEnv[k];
    if (v) env[k] = v;
  }
  return env;
}

function belowFloor(found: string): Error {
  return new Error(`Claude Code ${found} is too old; update it to ${MIN_CLAUDE_VERSION} or later.`);
}

/** Fails closed (spec §7.9): below the floor, or a binary whose version can't be read. */
export async function assertPluginFloor(bin: string, env: Record<string, string>): Promise<void> {
  const { version, tooOld } = await checkClaudeVersion(bin, env);
  if (!version) throw new Error(`Claude Code (${bin}) printed no readable version.`);
  if (tooOld) throw belowFloor(version);
}

/** Image digest to its in-flight or passed check. A failed check is dropped, so the next start asks again. */
const imageChecks = new Map<string, Promise<void>>();

/** Docker images, once per digest (spec §7.9): `docker run --rm --network none --security-opt no-new-privileges:true --entrypoint claude <digest> --version` (the image ID, so the result belongs to the digest it's cached under). */
export function checkImageClaudeVersion(image: string, digest: string): Promise<void> {
  let check = imageChecks.get(digest);
  if (!check) {
    check = runImageVersionCheck(image, digest);
    imageChecks.set(digest, check);
    check.catch(() => imageChecks.delete(digest));
  }
  return check;
}

/** Runs the image by its ID (`digest`), never by `image`: a tag can move between reading the ID and this probe. */
async function runImageVersionCheck(image: string, digest: string): Promise<void> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        ...SECURITY_OPT.flatMap((o) => ["--security-opt", o]),
        "--entrypoint",
        "claude",
        digest,
        "--version",
      ],
      { env: dockerCheckEnv(process.env), timeout: 60_000 },
      (err, out, stderr) => {
        if (err) {
          const why = redactOutput(capOutput(String(stderr || err.message)));
          reject(new Error(`Checking Claude Code in ${image} failed: ${why}`));
        } else resolve(String(out));
      },
    );
  });
  const found = /(\d+\.\d+\.\d+)/.exec(stdout)?.[1];
  if (!found) throw new Error(`Claude Code in ${image} printed no version.`);
  if (compareVersions(found, MIN_CLAUDE_VERSION) < 0) throw belowFloor(found);
}
