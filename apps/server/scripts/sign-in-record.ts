// Spec §11.3 steps 1-2. For Or to run by hand against the real `claude`: `pnpm --filter @open-factory/server sign-in:record`.
// Drives `claude setup-token` through the same PTY bridge and parsers the server uses, keeps the raw terminal output in
// memory, and writes it to ~/open-factory-sign-in-recording/ only after the URL, the code and the token are redacted.
// It prints the sign-in URL and paths, never the code, the token or any transcript text. CLAUDE_BIN overrides `claude`.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { startHostPty } from "../src/credentials/sign-in/host-pty.ts";
import { RunFailed, runSetupToken } from "../src/credentials/sign-in/setup-token.ts";
import { RedactionFailed, redactTranscript, writeRecording } from "./sign-in-redact.ts";

const claudeBin = process.env.CLAUDE_BIN ?? "claude";
const outDir = path.join(homedir(), "open-factory-sign-in-recording");

/** `claude --version` with HOME and CLAUDE_CONFIG_DIR in an empty temp dir, so it never touches the real ones. */
function claudeVersion(): string {
  const home = mkdtempSync(path.join(tmpdir(), "of-sign-in-version-"));
  try {
    const out = execFileSync(claudeBin, ["--version"], {
      env: { PATH: process.env.PATH ?? "", HOME: home, CLAUDE_CONFIG_DIR: home },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const v = out.trim().split(/\s+/)[0] ?? "";
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(v)) throw new Error("unexpected version output");
    return v;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** Lists the CLI's temp dir and names (never shows) the files that contain a token. Paths only. */
function inspectDir(dir: string): void {
  if (!existsSync(dir)) {
    console.log("\nThe temp dir was already gone; not inspected.");
    return;
  }
  try {
    console.log(`\nls -la ${dir}`);
    console.log(execFileSync("ls", ["-la", dir], { encoding: "utf8" }));
    const hits = (readdirSync(dir, { recursive: true, encoding: "utf8" }) as string[]).filter(
      (rel) => {
        try {
          return readFileSync(path.join(dir, rel)).includes("sk-ant-oat01");
        } catch {
          return false; // a directory or an unreadable file
        }
      },
    );
    console.log(
      hits.length
        ? `Files containing sk-ant-oat01:\n${hits.join("\n")}`
        : "No file contains sk-ant-oat01.",
    );
  } catch {
    console.log("Could not inspect the temp dir.");
  }
}

async function main(): Promise<void> {
  let version: string;
  try {
    version = claudeVersion();
  } catch {
    console.log("Could not read the claude version; nothing written.");
    process.exitCode = 1;
    return;
  }
  // Inspected once the CLI and the bridge have exited (so exit-time writes are seen), just before the dir is removed.
  const pty = await startHostPty({ claudeBin, beforeRemove: inspectDir });
  let raw = "";
  pty.onData((chunk) => {
    raw += chunk; // registered first, so it sees every chunk before the runner does
  });
  const run = runSetupToken(pty);

  try {
    const { url } = await run.prompt;
    console.log(`Open this URL, sign in, and paste the code below:\n\n${url}\n`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const code = (await rl.question("Code: ")).trim();
    rl.close();
    const token = await run.submit(code);

    const redacted = redactTranscript(raw, { url, code, token });
    const file = await writeRecording(outDir, `setup-token.recorded-${version}.txt`, redacted);
    console.log(`Wrote ${file}`);
  } catch (e) {
    if (e instanceof RedactionFailed) console.log("Redaction check failed; nothing written.");
    else if (e instanceof Error && (e as NodeJS.ErrnoException).code === "EEXIST")
      console.log("File exists; nothing written.");
    else if (e instanceof RunFailed) console.log(`Sign-in failed: ${e.reason}`);
    else console.log(`Failed: ${e instanceof Error ? e.name : "unknown error"}`);
    process.exitCode = 1;
  } finally {
    run.abort();
    await pty.exit;
  }
}

await main();
