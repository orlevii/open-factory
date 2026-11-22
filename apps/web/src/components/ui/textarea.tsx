import * as React from "react"
import { cn } from "cn"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      // A drag that starts in a field selects text; it must not drag a Vaul drawer.
      data-vaul-no-drag=""
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-lg border border-input bg-card px-2.5 py-2 text-sm pointer-coarse:text-base transition-colors placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
