import { TASK_STATUSES, type TaskStatus } from "@open-factory/shared";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { STATUS } from "./status-label";

/**
 * Status applies at once, so it is a menu, not a native select (a focused native select changes on each arrow key
 * on Windows and Linux, which here would wake agents one after another). Arrow keys move; only Enter, Space or a
 * click commits.
 */
export function StatusMenu({
  value,
  onCommit,
  disabled,
  pending,
}: {
  value: TaskStatus;
  onCommit(next: TaskStatus): void;
  disabled?: boolean;
  /** The last pick is saving: the menu won't open again yet, but its trigger stays focusable so the
   *  focus the closing menu hands back isn't dropped on <body> (a disabled button can't take it). */
  pending?: boolean;
}) {
  const s = STATUS[value];
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={(next) => setOpen(next && !pending)}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          disabled={disabled}
          aria-disabled={pending || undefined}
          aria-label={`Status: ${s.label}`}
          className="w-full min-w-0 justify-between"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <s.Icon aria-hidden="true" className={`size-3.5 ${s.icon}`} />
            <span className="truncate">{s.label}</span>
          </span>
          <ChevronDown aria-hidden="true" data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-(--radix-dropdown-menu-trigger-width)">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(v) => {
            if (v !== value) onCommit(v as TaskStatus);
          }}
        >
          {TASK_STATUSES.map((st) => {
            const x = STATUS[st];
            return (
              <DropdownMenuRadioItem key={st} value={st}>
                <x.Icon aria-hidden="true" className={x.icon} />
                {x.label}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
