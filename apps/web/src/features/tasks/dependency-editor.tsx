import { parseTaskKey, type TaskSummary } from "@open-factory/shared";
import { FieldShell } from "@/components/field-shell";
import { Input } from "@/components/ui/input";
import { lookupTasks } from "./api";
import { StatusLabel } from "./status-label";
import { TaskBadge } from "./task-badge";

/** Keys separated by commas or spaces, as typed ("T-41, T-44") -> canonical keys, duplicates dropped. */
export function parseKeys(text: string): { keys: string[]; bad?: string } {
  const keys: string[] = [];
  for (const raw of text.split(/[\s,]+/).filter(Boolean)) {
    const n = parseTaskKey(raw);
    if (n === null) return { keys, bad: raw };
    const k = `T-${n}`;
    if (!keys.includes(k)) keys.push(k);
  }
  return { keys };
}

/**
 * UI design §8.2's checks, in order: key syntax, count, not itself, and (one request) that every key exists.
 * `resolved` is what the badges show. The server's cycle sentence still arrives on save.
 */
export async function checkDependencies(
  text: string,
  selfKey?: string,
): Promise<{ keys: string[]; resolved: TaskSummary[]; error?: string }> {
  const { keys, bad } = parseKeys(text);
  if (bad !== undefined) return { keys, resolved: [], error: "Use task keys, like T-41." };
  if (keys.length > 50)
    return { keys, resolved: [], error: "A task can depend on at most 50 tasks." };
  if (selfKey && keys.includes(selfKey))
    return { keys, resolved: [], error: "A task can't depend on itself." };
  if (!keys.length) return { keys, resolved: [] };
  const found = await lookupTasks(keys);
  const missing = keys.find((k) => !found.some((t) => t.key === k));
  const resolved = keys.flatMap((k) => found.filter((t) => t.key === k));
  return missing ? { keys, resolved, error: `No task ${missing}.` } : { keys, resolved };
}

/** One text input for the keys, with the resolved tasks below as badges with their status. */
export function DependencyEditor({
  value,
  onChange,
  onBlur,
  error,
  resolved,
  name = "dependsOn",
}: {
  value: string;
  onChange(v: string): void;
  onBlur(): void;
  error?: string | undefined;
  resolved: TaskSummary[];
  name?: string;
}) {
  return (
    <FieldShell name={name} label="Depends on" error={error} help="Task keys, like T-41.">
      {(a) => (
        <>
          <Input
            id={a.id}
            name={name}
            value={value}
            aria-invalid={a.invalid || undefined}
            aria-describedby={a.describedBy}
            autoComplete="off"
            onChange={(e) => onChange(e.target.value)}
            onBlur={onBlur}
            className="h-9 bg-card font-mono dark:bg-card"
          />
          {resolved.length > 0 && (
            <ul aria-label="Resolved dependencies" className="grid gap-1">
              {resolved.map((t) => (
                <li key={t.key} className="flex min-w-0 items-center gap-2 text-[0.8125rem]">
                  <TaskBadge taskKey={t.key} title={t.title} />
                  <StatusLabel status={t.status} className="ml-auto text-muted-foreground" />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </FieldShell>
  );
}
