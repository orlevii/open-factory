import { spawn } from "node:child_process";
import { createFakeClaude } from "@open-factory/harness/testing";
import { makeTestApp, signUp, type TestAppOptions } from "./helpers.ts";

export {
  SYNTHETIC_CODE,
  SYNTHETIC_TOKEN,
  SYNTHETIC_URL,
} from "../../../../packages/harness/testing/synthetic-sign-in.mjs";

/**
 * A test app whose `claude` is the fake CLI (I3: `setup-token` prints the synthetic sign-in screen; the
 * `reply` scenario verifies any token), with every sign-in spawn recorded, and one signed-up user.
 * The real `claude` never runs: FACTORY_CLAUDE_BIN is the fake's wrapper.
 */
export async function appWithFakeClaude(
  o: Pick<TestAppOptions, "logLevel" | "logStream"> & {
    /** Wraps the real spawn (e.g. to hide python3 from PATH); recorded either way. */
    spawnFn?: typeof spawn;
  } = {},
) {
  const fake = createFakeClaude({ scenario: "reply" });
  const spawnCalls: unknown[][] = [];
  const inner = o.spawnFn ?? spawn;
  const signInSpawn = ((...a: Parameters<typeof spawn>) => {
    spawnCalls.push(a);
    return (inner as (...args: Parameters<typeof spawn>) => ReturnType<typeof spawn>)(...a);
  }) as typeof spawn;
  const t = await makeTestApp({
    env: { FACTORY_CLAUDE_BIN: fake.bin },
    signInSpawn,
    ...(o.logLevel ? { logLevel: o.logLevel } : {}),
    ...(o.logStream ? { logStream: o.logStream } : {}),
  });
  const { cookie, user } = await signUp(t.app);
  return { t, app: t.app, cookie, user, fake, spawnCalls };
}
