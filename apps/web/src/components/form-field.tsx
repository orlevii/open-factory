import type { ComponentProps, ReactNode } from "react";
import { FieldShell } from "@/components/field-shell";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Props = Omit<ComponentProps<"input">, "id" | "name" | "prefix"> & {
  name: string;
  label: string;
  error?: string;
  /** Muted hint under the field. An error replaces it in the same slot. */
  help?: string;
  /** Visual-only adornment inside the left edge (e.g. "@"); never part of the value. */
  prefix?: string;
  /** Control in the label row, right-aligned (e.g. a help trigger); never spread onto the input. */
  action?: ReactNode;
};

export function FormField({
  name,
  label,
  error,
  help,
  prefix,
  action,
  className,
  ...input
}: Props) {
  return (
    <FieldShell name={name} label={label} error={error} help={help} action={action}>
      {(a) => {
        const field = (
          <Input
            id={a.id}
            name={name}
            aria-invalid={a.invalid || undefined}
            aria-describedby={a.describedBy}
            className={cn("h-9", prefix && "pl-7", className)}
            {...input}
          />
        );
        return prefix ? (
          <div className="relative flex items-center">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-3 font-mono text-sm text-muted-foreground"
            >
              {prefix}
            </span>
            {field}
          </div>
        ) : (
          field
        );
      }}
    </FieldShell>
  );
}
