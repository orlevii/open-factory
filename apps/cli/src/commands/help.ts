import { COMMANDS, type Io } from "../commands.ts";

export function help(io: Io): number {
  io.out("Usage: open-factory <command> [options]\n\nCommands:");
  for (const c of COMMANDS) io.out(`  ${c.name.padEnd(8)} ${c.summary}`);
  io.out("\nOptions:\n  --version  Print the CLI version");
  io.out("\nEnvironment: OPEN_FACTORY_URL, OPEN_FACTORY_TOKEN override the stored config.");
  return 0;
}
