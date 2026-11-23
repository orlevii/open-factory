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

function PopoverAnchor({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  ref,
  onEscapeKeyDown,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  const node = React.useRef<HTMLDivElement | null>(null)
  // Keep the caller's ref and our own node in one stable callback (no ref writes during render).
  const setNode = React.useCallback(
    (n: HTMLDivElement | null) => {
      node.current = n
      if (typeof ref === "function") return ref(n)
      if (ref) (ref as React.RefObject<HTMLDivElement | null>).current = n
    },
    [ref]
  )
  const stamped = useStampedRef(setNode)
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        ref={stamped}
        // DESIGN.md Motion: a key that closes an overlay closes it at once, however it was opened.
        onEscapeKeyDown={(e) => {
          onEscapeKeyDown?.(e)
          if (!e.defaultPrevented) node.current?.setAttribute("data-instant", "")
        }}
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

function PopoverTitle(
  props: React.ComponentProps<typeof PopoverPrimitive.Title>
) {
  return <PopoverPrimitive.Title data-slot="popover-title" {...props} />
}

function PopoverDescription(
  props: React.ComponentProps<typeof PopoverPrimitive.Description>
) {
  return (
    <PopoverPrimitive.Description data-slot="popover-description" {...props} />
  )
}

export {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
}
