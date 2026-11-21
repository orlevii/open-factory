import * as React from "react"
import { cn } from "cn"
import { Select as SelectPrimitive } from "radix-ui"
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react"
import { useStampedRef } from "@/lib/input-modality"

/** Sentinel item value for "no filter / all". Radix forbids `""` as an item value, so "all" needs a non-empty one. */
export const ALL = "__all"

function Select({ ...props }: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />
}

function SelectGroup({ ...props }: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />
}

// The native title (for truncated values) only works when children is a string; a node child gets none.
function SelectValue({
  children,
  title,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      title={title ?? (typeof children === "string" ? children : undefined)}
      {...props}
    >
      {children}
    </SelectPrimitive.Value>
  )
}

function SelectTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        "flex h-8 pointer-coarse:h-9 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-input bg-card px-2.5 text-sm data-placeholder:text-muted-foreground aria-invalid:border-destructive disabled:cursor-not-allowed disabled:text-muted-foreground [&>span]:truncate",
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

function SelectContent({
  className,
  children,
  ref,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        ref={useStampedRef(ref)}
        position="popper"
        sideOffset={4}
        className={cn(
          "z-50 min-w-(--radix-select-trigger-width) max-w-(--radix-select-content-available-width) max-h-(--radix-select-content-available-height) origin-(--radix-select-content-transform-origin) overflow-hidden rounded-lg border border-float-edge bg-popover p-1 text-popover-foreground duration-100 ease-(--ease-out) data-closed:duration-75 data-open:animate-in data-open:fade-in-0 motion-safe:data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0",
          className
        )}
        {...props}
      >
        <SelectPrimitive.ScrollUpButton className="flex h-6 items-center justify-center text-muted-foreground">
          <ChevronUpIcon className="size-4" />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="flex h-6 items-center justify-center text-muted-foreground">
          <ChevronDownIcon className="size-4" />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn("px-2 py-1.5 text-xs text-muted-foreground", className)}
      {...props}
    />
  )
}

function SelectItem({
  className,
  children,
  textValue,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item> & { textValue?: string }) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      textValue={textValue}
      className={cn(
        "relative flex min-h-8 pointer-coarse:min-h-9 w-full cursor-default items-center gap-2 rounded-md py-1.5 pr-8 pl-2 text-sm outline-hidden select-none [overflow-wrap:anywhere] focus:bg-accent data-disabled:pointer-events-none data-disabled:text-muted-foreground", // ui-contract:allow focus is a fill
        className
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <span className="absolute right-2 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-4 text-foreground" />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  )
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
}
