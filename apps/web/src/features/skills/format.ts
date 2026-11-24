/** "190 agents", with a non-breaking space: only a number and its noun are kept together (spec §10.2). */
export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Used by 3 templates · 2 agents", with zero kinds left out, or "Not used". */
export function usedByText(templates: number, agents: number): string {
  const parts = [
    ...(templates > 0 ? [count(templates, "template")] : []),
    ...(agents > 0 ? [count(agents, "agent")] : []),
  ];
  return parts.length === 0 ? "Not used" : `Used by ${parts.join(" · ")}`;
}
