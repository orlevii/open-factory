import { CircleAlert } from "lucide-react";
import type { ComponentProps } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type Props = Omit<ComponentProps<"input">, "id" | "name" | "prefix"> & {
  name: string;
  label: string;
  error?: string;
  /** Muted hint under the field. An error replaces it in the same slot. */
  help?: string;
  /** Visual-only adornment inside the left edge (e.g. "@"); never part of the value. */
  prefix?: string;
};

export function FormField({ name, label, error, help, prefix, className, ...input }: Props) {
  const id = `field-${name}`;
  const errorId = `${id}-error`;
  const helpId = `${id}-help`;
  const field = (
    <Input
      id={id}
      name={name}
      aria-invalid={error ? true : undefined}
      // Exactly one description: the error when there is one, else the help text.
      aria-describedby={error ? errorId : help ? helpId : undefined}
      className={cn("h-9 bg-card dark:bg-card", prefix && "pl-7", className)}
      {...input}
    />
  );
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-[0.8125rem]">
        {label}
      </Label>
      {prefix ? (
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
      )}
      {error ? (
        <p
          id={errorId}
          className="flex items-start gap-1.5 text-[0.8125rem] leading-[1.125rem] text-destructive"
        >
          <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {error}
        </p>
      ) : (
        help && (
          <p id={helpId} className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
            {help}
          </p>
        )
      )}
    </div>
  );
}
