import type { TaskAgentRef } from "@open-factory/shared";
import type { ComboOption } from "@/components/ui/combobox";
import { AgentCombobox } from "@/features/agents/agent-combobox";

/** Never an agent's slug (slugs are lowercase words), so it matches no option: nothing is checked. */
const ENDED = "\u0000ended";
const UNASSIGNED: ComboOption[] = [{ value: "", label: "Unassigned", fixed: true }];
const chooseAgent = () => "Choose an agent…";

/**
 * The detail page's Assignee: a searchable picker that commits only on Enter or a click (a native select
 * would assign and wake agents on each arrow key). An ended assignee shows above the trigger, muted, and
 * the trigger reads "Choose an agent…".
 */
export function AssigneeMenu({
  value,
  onCommit,
  disabled,
  pending,
}: {
  value: TaskAgentRef | null;
  /** A slug, or null to unassign. */
  onCommit(next: string | null): void;
  disabled?: boolean;
  /** The last pick is saving: the picker won't open again yet, but keeps focus. */
  pending?: boolean;
}) {
  const ended = value?.ended;
  const current = value && !ended ? value.slug : null;
  const text = ended ? "Choose an agent…" : value ? `@${value.slug}` : "Unassigned";
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-1">
      {value && ended && (
        <p className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
          <span className="font-mono">@{value.slug}</span> · {ended}
        </p>
      )}
      <AgentCombobox
        aria-label={`Assignee: ${text}`}
        scope="live"
        fixed={UNASSIGNED}
        disabled={disabled}
        pending={pending}
        triggerClassName="w-full min-w-0"
        value={ended ? ENDED : current}
        renderValue={ended ? chooseAgent : undefined}
        onValueChange={(next) => {
          // An ended assignee has no live current value, so Unassigned (null) is a real change.
          if (!ended && next === current) return;
          onCommit(next);
        }}
      />
    </div>
  );
}
