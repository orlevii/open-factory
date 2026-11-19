import type { TemplateConfig } from "@open-factory/shared";

export type DenyRules = { permissionsDeny: string[]; softDeny: string[]; hardDeny: string[] };
export type ProjectRef = { id: string; name: string; hostPath: string };
export type SpawnerState = {
  runtime: "local" | "docker";
  permissionMode: "auto" | "bypass";
  credentialId: string;
  grants: ProjectRef[];
  secrets: string[];
  deny: DenyRules;
};
export type Inherited =
  | { ok: false; refusal: string }
  | {
      ok: true;
      credentialId: string;
      grants: ProjectRef[];
      secrets: string[];
      deny: DenyRules;
      dropped: { secrets: string[]; projects: string[] };
    };

const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];

export function readDenyRules(settings: Record<string, unknown>): DenyRules {
  const auto = obj(settings.autoMode);
  const no$ = (l: string[]) => l.filter((x) => x !== "$defaults");
  return {
    permissionsDeny: strs(obj(settings.permissions).deny),
    softDeny: no$(strs(auto.soft_deny)),
    hardDeny: no$(strs(auto.hard_deny)),
  };
}

/** S7 §6: a child never holds something its spawner lacks. The one owner of the rule. */
export function inheritFrom(
  spawner: SpawnerState,
  child: TemplateConfig,
  childDeny: DenyRules,
  env: { localRuntimeAllowed: boolean },
): Inherited {
  const t = child.name;
  if (child.runtime === "local" && spawner.runtime === "docker")
    return {
      ok: false,
      refusal: `Template ${t} runs locally, outside the sandbox you run in, so you can't spawn it.`,
    };
  if (child.runtime === "local" && !env.localRuntimeAllowed)
    return {
      ok: false,
      refusal: `Template ${t} needs the local runtime, which this factory doesn't allow.`,
    };
  if (child.permissionMode === "bypass" && spawner.permissionMode === "auto")
    return {
      ok: false,
      refusal: `Template ${t} runs without permission checks, which you don't have, so you can't spawn it.`,
    };
  const held = new Map(spawner.grants.map((g) => [g.name, g]));
  const grants = child.projects.flatMap((n) => {
    const g = held.get(n);
    return g ? [g] : [];
  });
  const secrets = child.secrets.filter((s) => spawner.secrets.includes(s));
  return {
    ok: true,
    credentialId: spawner.credentialId,
    grants,
    secrets,
    deny: {
      permissionsDeny: union(childDeny.permissionsDeny, spawner.deny.permissionsDeny),
      softDeny: union(childDeny.softDeny, spawner.deny.softDeny),
      hardDeny: union(childDeny.hardDeny, spawner.deny.hardDeny),
    },
    dropped: {
      secrets: child.secrets.filter((s) => !spawner.secrets.includes(s)),
      projects: child.projects.filter((n) => !held.has(n)),
    },
  };
}

export function droppedNote(d: { secrets: string[]; projects: string[] }): string | undefined {
  const parts = [
    ...(d.secrets.length ? [`secrets ${d.secrets.join(", ")}`] : []),
    ...(d.projects.length ? [`projects ${d.projects.join(", ")}`] : []),
  ];
  return parts.length
    ? `Not passed on, because you don't hold them: ${parts.join("; ")}.`
    : undefined;
}
