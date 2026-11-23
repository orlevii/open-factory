import { parseTaskKey, type TaskSummary } from "@open-factory/shared";
import { FieldShell } from "@/components/field-shell";
import { Input } from "@/components/ui/input";
import { FORM_MSG } from "@/lib/form-messages";
import { lookupTasks } from "./api";

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
  return missing ? { keys, resolved, error: FORM_MSG.noSuchTask } : { keys, resolved };
}

/** "Depends on T-41.", "... T-41 and T-52." or "... T-41, T-44 and 3 more." (kept short for the one-line note). */
export function dependsSummary(keys: string[]): string {
  if (!keys.length) return "";
  if (keys.length === 1) return `Depends on ${keys[0]}.`;
  if (keys.length === 2) return `Depends on ${keys[0]} and ${keys[1]}.`;
  return `Depends on ${keys[0]}, ${keys[1]} and ${keys.length - 2} more.`;
}

/** One text input for the keys; the resolved keys are summarized in the note. */
export function DependencyEditor({
  value,
  onChange,
  onBlur,
  error,
  resolvedKeys,
  name = "dependsOn",
}: {
  value: string;
  onChange(v: string): void;
  onBlur(): void;
  error?: string | undefined;
  resolvedKeys: string[];
  name?: string;
}) {
  return (
    <FieldShell
      name={name}
      label="Depends on"
      error={error}
      help={resolvedKeys.length ? dependsSummary(resolvedKeys) : "Task keys, like T-41."}
    >
      {(a) => (
        <Input
          id={a.id}
          name={name}
          value={value}
          aria-invalid={a.invalid || undefined}
          aria-describedby={a.describedBy}
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          className="h-9 font-mono"
        />
      )}
    </FieldShell>
  );
}
