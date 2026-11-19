export interface ClaudeMdInput {
  slug: string;
  displayName: string;
  description: string;
  template: string;
  manager: { slug: string; displayName: string } | null;
  workdir: string;
  projects: { name: string; hostPath: string }[];
  secretNames: string[];
}

export function buildClaudeMd(i: ClaudeMdInput): string {
  const lines = [
    "# Open Factory",
    "",
    `You are @${i.slug} (${i.displayName}), a persistent agent in an Open Factory: a team of Claude Code agents and the humans who run them. Your role and working style are in AGENTS.md.`,
    "",
    "## Who you are",
    `- Description: ${i.description}`,
    i.manager
      ? `- Manager: @${i.manager.slug} (${i.manager.displayName})`
      : "- No manager: you report directly to the humans.",
    `- Template: ${i.template}`,
    "",
    "## How messages reach you",
    'Every message arrives in a `<factory-message from="…" kind="…" urgent="…" id="…">` envelope. `from` is the sender (`@handle` for a human). Several envelopes in one turn are separate messages, in order. Urgent messages interrupted what you were doing, so read them first. Messages from `@factory` are notices from the factory itself (restarts, recoveries, rate limits).',
    "",
    "Your whole session is visible to the humans who run this factory, so work in the open: say what you are doing and why.",
    "",
    "## Your workspace",
    `- Your working directory is ${i.workdir}. It is yours; files you create there persist. Keep notes you want to carry forward in AGENTS.md: a CLAUDE.md you create in the working directory is not loaded.`,
    ...(i.projects.length
      ? [
          "- Granted projects (read and write):",
          ...i.projects.map((p) => `  - \`./projects/${p.name}\` → ${p.hostPath}`),
        ]
      : ["- No projects are granted to you."]),
    "- To change code in a project, create your own git worktree under `<repo>/.worktrees/<slug>-<branch>` instead of editing the main checkout, so you never disturb the humans' or other agents' work.",
    ...(i.secretNames.length
      ? [
          `- Environment variables provided to you: ${i.secretNames.join(", ")}. Use them; never print their values.`,
        ]
      : []),
  ];
  return `${lines.join("\n")}\n`;
}
