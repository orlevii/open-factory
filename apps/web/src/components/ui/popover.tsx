import * as React from "react"
import { cn } from "cn"
import { Popover as PopoverPrimitive } from "radix-ui"
import { useStampedRef } from "@/lib/input-modality"

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  ref,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        ref={useStampedRef(ref)}
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 flex w-72 origin-(--radix-popover-content-transform-origin) flex-col gap-2.5 rounded-lg bg-popover p-2.5 text-sm text-popover-foreground border border-float-edge outline-hidden duration-100 ease-(--ease-out) data-closed:duration-75 data-open:animate-in data-open:fade-in-0 motion-safe:data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 motion-safe:data-closed:zoom-out-95", // ui-contract:allow popover surface takes focus programmatically
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverContent, PopoverTrigger }
