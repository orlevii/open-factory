/** The fixed texts of every `@factory` system message (spec §9.5). Every claim is literally true. */
export type NoticeType =
  | "crash"
  | "factory_restarted"
  | "restart"
  | "restart_applied"
  | "restart_crons"
  | "config_continue"
  | "rate_limit_reset"
  | "crons_stopped"
  | "compact_continue"
  | "config_changed"
  | "report_config_changed"
  | "loop_held";

/** I2 §7.3: the fixed first line of the `config_changed` notice; every following line is one change, as "- …". */
export const CONFIG_NOTICE_HEADER = "Your configuration changed:";

/**
 * I2 §7.3: the `config_changed` body, which `parseConfigNotice` reads back: the header, then each line once, sorted.
 * The lines are `describeChanges` output (secret-safe); a line break inside one is flattened so the body stays parseable.
 */
export function renderConfigNotice(
  lines: readonly string[],
  header: string = CONFIG_NOTICE_HEADER,
): string {
  const items = [...new Set(lines.map((l) => l.replace(/\s*\n\s*/g, " ").trim()))]
    .filter(Boolean)
    .sort();
  return [header, ...items.map((l) => `- ${l}`)].join("\n");
}

/** The change lines of a `config_changed` body (`renderConfigNotice`'s inverse); anything else in it is ignored. */
export function parseConfigNotice(body: string): string[] {
  return body.split("\n").flatMap((l) => (l.startsWith("- ") ? [l.slice(2)] : []));
}

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
    return [
      `Restarted by ${i.by} after an error.`,
      ...tasksSentence(i.tasks),
      ...cronsSentence(i.crons),
    ].join(" ");
  },
  /** I7 §9.2.1: the waking notice of a restart that applies config; `changes` empty or null names none. */
  restartApplied(i: {
    by: string;
    changes: string[] | null;
    tasks: string[];
    crons: string[];
  }): string {
    return [
      i.changes?.length
        ? `Restarted by ${i.by} to apply: ${i.changes.join(", ")}.`
        : `Restarted by ${i.by}.`,
      ...tasksSentence(i.tasks),
      ...cronsSentence(i.crons),
      "Continue where you left off.",
    ].join(" ");
  },
  restartCrons(i: { crons: string[] }): string {
    return [
      "Your session was restarted to apply configuration changes.",
      ...cronsSentence(i.crons),
      "Recreate them if you still need them.",
    ].join(" ");
  },
  /** I7 §9.5: the waking notice of a self-edit restart; `crons` empty when the crons_stopped notice already lists them. */
  configContinue(i: { crons: string[] }): string {
    return [
      "Restarted to apply your config changes. Continue where you left off.",
      ...(i.crons.length
        ? [`These crons were stopped: ${i.crons.join("; ")}; recreate them if you still need them.`]
        : []),
    ].join(" ");
  },
  /** S9 §10.3: a human stopped the agent's in-session crons; a passive notice (never wakes the agent by itself). */
  cronsStopped(i: { by: string; crons: string[] }): string {
    return `${i.by} stopped your crons: ${i.crons.join("; ")}. A human stopped them on purpose, so don't recreate them unless you are asked to.`;
  },
  /** I1 §7: an agent compacted itself. Fixed text: Claude's failure text is process output and is never quoted. */
  compactContinue(i: { failed: boolean }): string {
    return i.failed
      ? "Your /compact didn't run (see the Session). Continue where you left off."
      : "Your /compact finished. Continue where you left off.";
  },
  /** I2 §7.3: passive; one pending row accumulates every change (`EventStore.createNotice`'s merge mode). */
  configChanged: renderConfigNotice,
  /**
   * I7 §8.2: passive, to an agent's manager; one pending row per (manager, report) accumulates the lines, and the
   * header names the latest actor. `by` is the actor's `@handle`, `report` the report's slug. The `config_changed` shape,
   * so `parseConfigNotice` reads it back.
   */
  reportConfigChanged(i: { by: string; report: string; lines: readonly string[] }): string {
    return renderConfigNotice(i.lines, `${i.by} changed @${i.report}'s configuration:`);
  },
  /** `at` only when the reset time was exact. */
  rateLimitReset(i: { credential: string; at?: Date }): string {
    return `The rate limit on credential \`${i.credential}\` reset${i.at ? ` at ${hhmm(i.at)}` : ""}. Continue where you left off.`;
  },
};
