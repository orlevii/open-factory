import type { TaskAgentRef } from "@open-factory/shared";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { agentOptionLabel, useAssignableAgents } from "./agent-picker";

const NONE = "__none";
const UNASSIGNED = "__unassigned";

/**
 * The detail page's Assignee: a labelled menu (a native select would assign and wake agents on each arrow key).
 * An ended assignee shows above the trigger, muted, and the trigger reads "Choose an agent…".
 */
export function AssigneeMenu({
  value,
  onCommit,
  disabled,
}: {
  value: TaskAgentRef | null;
  /** A slug, or null to unassign. */
  onCommit(next: string | null): void;
  disabled?: boolean;
}) {
  const { agents } = useAssignableAgents();
  const ended = value?.ended;
  const current = value && !ended ? value.slug : value ? NONE : UNASSIGNED;
  const text = ended ? "Choose an agent…" : value ? `@${value.slug}` : "Unassigned";
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-1">
      {value && ended && (
        <p className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
          <span className="font-mono">@{value.slug}</span> · {ended}
        </p>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            disabled={disabled}
            aria-label={`Assignee: ${text}`}
            className="w-full min-w-0 justify-between"
          >
            <span className={`min-w-0 truncate ${value && !ended ? "font-mono" : ""}`}>{text}</span>
            <ChevronDown aria-hidden="true" data-icon="inline-end" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-(--radix-dropdown-menu-trigger-width)">
          <DropdownMenuRadioGroup
            value={current}
            onValueChange={(v) => {
              if (v === current) return;
              onCommit(v === UNASSIGNED ? null : v);
            }}
          >
            <DropdownMenuRadioItem value={UNASSIGNED}>Unassigned</DropdownMenuRadioItem>
            {agents.map((a) => (
              // Typeahead matches the slug as typed ("dev-042"), as the Selects do, not "@dev-042".
              <DropdownMenuRadioItem key={a.slug} value={a.slug} textValue={a.slug}>
                {agentOptionLabel(a)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
