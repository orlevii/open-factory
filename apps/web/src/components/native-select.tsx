import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "h-8 pointer-coarse:h-9 w-full min-w-0 rounded-lg border border-input bg-card px-2.5 text-sm aria-invalid:border-destructive disabled:cursor-not-allowed disabled:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
