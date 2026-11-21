import * as React from "react"
import { cn } from "cn"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-8 pointer-coarse:h-9 w-full min-w-0 rounded-lg border border-input bg-card px-2.5 py-1 text-sm pointer-coarse:text-base transition-colors placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground aria-invalid:border-destructive file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export { Input }
