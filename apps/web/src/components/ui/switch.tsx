import { Switch as SwitchPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "cn";

function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full border bg-muted transition-colors data-[state=checked]:border-primary data-[state=checked]:bg-primary disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-4 translate-x-0.5 rounded-full bg-background shadow-sm transition-transform data-[state=checked]:translate-x-[1.125rem]" />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
