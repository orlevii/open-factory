/** The fixed texts of every `@factory` system message (spec §9.5). Every claim is literally true. */
export type NoticeType =
  | "crash"
  | "factory_restarted"
  | "restart"
  | "restart_crons"
  | "rate_limit_reset";

const tasksSentence = (tasks: string[]) =>
  tasks.length
    ? [`These background tasks were stopped: ${tasks.map((t) => `\`${t}\``).join(", ")}.`]
    : [];
const cronsSentence = (crons: string[]) =>
  crons.length ? [`These crons were stopped: ${crons.join(", ")}.`] : [];

const hhmm = (d: Date) =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

export const notices = {
  crash(i: {
    exit: { code: number | null; signal: string | null };
    duringTurn: boolean;
    tasks: string[];
    crons: string[];
  }): string {
    const how = i.exit.signal
      ? ` (signal ${i.exit.signal})`
      : i.exit.code !== null
        ? ` (exit code ${i.exit.code})`
        : "";
    return [
      `Your previous process stopped unexpectedly${how}${i.duringTurn ? " during a turn" : ""}.`,
      ...tasksSentence(i.tasks),
      ...cronsSentence(i.crons),
      "Check the state of that work and continue where you left off.",
    ].join(" ");
  },
  factoryRestarted(i: { tasks: string[] }): string {
    return [
      "The factory restarted while you were working.",
      ...tasksSentence(i.tasks),
      "Check the state of that work and continue where you left off.",
    ].join(" ");
  },
  restart(i: { by: string; tasks: string[]; crons: string[] }): string {
    const by = i.by.startsWith("@") ? i.by : `@${i.by}`;
    return [
      `Restarted by ${by} after an error.`,
      ...tasksSentence(i.tasks),
      ...cronsSentence(i.crons),
    ].join(" ");
  },
  restartCrons(i: { crons: string[] }): string {
    return [
      "Your session was restarted to apply configuration changes.",
      ...cronsSentence(i.crons),
      "Recreate them if you still need them.",
    ].join(" ");
  },
  /** `at` only when the reset time was exact. */
  rateLimitReset(i: { credential: string; at?: Date }): string {
    return `The rate limit on credential \`${i.credential}\` reset${i.at ? ` at ${hhmm(i.at)}` : ""}. Continue where you left off.`;
  },
};
