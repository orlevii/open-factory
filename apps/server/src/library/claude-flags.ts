import { execFile } from "node:child_process";
import { checkClaudeVersion, compareVersions, MIN_CLAUDE_VERSION } from "@open-factory/harness";

/** `claude --version` runs on the host, so it gets the plugin CLI's rule (spec §11.7): never the
 *  agent's env or its agent-writable `CLAUDE_CONFIG_DIR`, only `PATH` and the host `HOME`. */
export function versionCheckEnv(serverEnv: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  if (serverEnv.PATH) env.PATH = serverEnv.PATH;
  if (serverEnv.HOME) env.HOME = serverEnv.HOME;
  return env;
}

function belowFloor(found: string): Error {
  return new Error(`Claude Code ${found} is too old; update it to ${MIN_CLAUDE_VERSION} or later.`);
}

/** Fails closed below the floor (spec §7.9), on top of the harness check. A binary whose version can't be read
 *  is not refused here. */
export async function assertPluginFloor(bin: string, env: Record<string, string>): Promise<void> {
  const { version, tooOld } = await checkClaudeVersion(bin, env);
  if (version && tooOld) throw belowFloor(version);
}

/** Image digest to its in-flight or passed check. A failed check is dropped, so the next start asks again. */
const imageChecks = new Map<string, Promise<void>>();

/** Docker images, once per digest (spec §7.9): `docker run --rm --network none --entrypoint claude <image> --version`. */
export function checkImageClaudeVersion(image: string, digest: string): Promise<void> {
  let check = imageChecks.get(digest);
  if (!check) {
    check = runImageVersionCheck(image);
    imageChecks.set(digest, check);
    check.catch(() => imageChecks.delete(digest));
  }
  return check;
}

async function runImageVersionCheck(image: string): Promise<void> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      "docker",
      ["run", "--rm", "--network", "none", "--entrypoint", "claude", image, "--version"],
      { env: versionCheckEnv(process.env), timeout: 60_000 },
      (err, out, stderr) => {
        if (err)
          reject(new Error(`Checking Claude Code in ${image} failed: ${stderr || err.message}`));
        else resolve(String(out));
      },
    );
  });
  const found = /(\d+\.\d+\.\d+)/.exec(stdout)?.[1];
  if (!found) throw new Error(`Claude Code in ${image} printed no version.`);
  if (compareVersions(found, MIN_CLAUDE_VERSION) < 0) throw belowFloor(found);
}
