import { readFileSync } from "node:fs";
import { help } from "./commands/help.ts";
import { images } from "./commands/images.ts";
import { login } from "./commands/login.ts";
import { logout } from "./commands/logout.ts";
import { status } from "./commands/status.ts";

declare const __FACTORY_VERSION__: string | undefined;
// Injected by esbuild in the bundle; read from the root package.json when running from source.
export const CLI_VERSION: string =
  typeof __FACTORY_VERSION__ === "string"
    ? __FACTORY_VERSION__
    : (
        JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
          version: string;
        }
      ).version;

export interface Io {
  out(s: string): void;
  err(s: string): void;
  ask(q: string, def?: string): Promise<string>;
  askHidden(q: string): Promise<string>;
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
}

export interface Command {
  name: string;
  summary: string;
  run(args: string[], io: Io): Promise<number>;
}

/** The command table: the seam for future commands. */
export const COMMANDS: Command[] = [
  {
    name: "login",
    summary: "Log in to a factory server: open-factory login [--url <url>]",
    run: login,
  },
  { name: "logout", summary: "Log out and forget the stored token", run: logout },
  { name: "status", summary: "Show server, version and login state", run: status },
  {
    name: "images",
    summary: "List user images or build one: open-factory images [build <name>|--all] [--no-pull]",
    run: images,
  },
  { name: "help", summary: "Show this help", run: async (_a, io) => help(io) },
];

export async function run(argv: string[], io: Io): Promise<number> {
  const [name, ...rest] = argv;
  if (name === "--version" || name === "-v") {
    io.out(CLI_VERSION);
    return 0;
  }
  if (!name || name === "--help" || name === "-h") return help(io);
  const cmd = COMMANDS.find((c) => c.name === name);
  if (!cmd) {
    io.err(`Unknown command: ${name}\n`);
    help(io);
    return 1;
  }
  try {
    return await cmd.run(rest, io);
  } catch (e) {
    // UnreachableError and parseArgs errors carry a plain, user-facing message.
    io.err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
