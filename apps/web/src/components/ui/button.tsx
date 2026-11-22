import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,scale] duration-150 ease-(--ease-out) select-none active:not-aria-[haspopup]:scale-[0.98] disabled:pointer-events-none disabled:text-muted-foreground aria-disabled:not-aria-busy:cursor-not-allowed aria-disabled:not-aria-busy:text-muted-foreground aria-disabled:not-aria-busy:hover:text-muted-foreground aria-disabled:active:scale-100 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/80 disabled:bg-card disabled:border-border aria-disabled:not-aria-busy:bg-card aria-disabled:not-aria-busy:border-border aria-disabled:not-aria-busy:hover:bg-card",
        outline:
          "border-border bg-card hover:bg-muted hover:text-foreground aria-expanded:bg-muted dark:border-border dark:bg-card dark:hover:bg-muted disabled:bg-card disabled:border-border aria-disabled:not-aria-busy:bg-card aria-disabled:not-aria-busy:border-border aria-disabled:not-aria-busy:hover:bg-card dark:aria-disabled:not-aria-busy:hover:bg-card",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50 disabled:bg-transparent aria-disabled:not-aria-busy:bg-transparent aria-disabled:not-aria-busy:hover:bg-transparent dark:aria-disabled:not-aria-busy:hover:bg-transparent",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 disabled:bg-card disabled:border-border aria-disabled:not-aria-busy:bg-card aria-disabled:not-aria-busy:border-border aria-disabled:not-aria-busy:hover:bg-card dark:disabled:bg-card dark:aria-disabled:not-aria-busy:bg-card dark:aria-disabled:not-aria-busy:hover:bg-card",
        link: "text-primary underline-offset-4 hover:underline aria-disabled:not-aria-busy:hover:no-underline",
      },
      size: {
        default:
          "h-8 pointer-coarse:h-10 pointer-coarse:min-w-10 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 pointer-coarse:h-10 pointer-coarse:min-w-10 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8 pointer-coarse:size-9",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

/** Sizes under 40px that take the coarse-pointer `::after` expander (`hit-40` in styles.css, U4 §11.3): the glyph
 *  keeps its size and the hit box grows to 40×40. `default` and `lg` grow for real instead (`min-w-10` for a header
 *  action whose label goes sr-only on phones, leaving only its icon). */
const EXPANDED = new Set(["icon", "icon-xs", "icon-sm", "icon-lg", "xs", "sm"])

/** A button inside a form: no expander (it would overlap a field or prose); on coarse pointers it grows to 40px
 *  with real padding instead, and the form's gaps make room. */
const IN_FORM = "pointer-coarse:min-h-10 pointer-coarse:px-3"

/** A toolbar or header group on coarse pointers: its icon buttons are visible 40px boxes 4px apart, so neighbouring
 *  expanders never overlap (U4 §11.3). Matched by `data-size` alone: a Button inside a `TooltipTrigger` or menu
 *  trigger (`asChild`) takes the trigger's `data-slot`, and the session header's Agent details and ⋯ stayed 36px and
 *  28px with overlapping expanders (evidence D2). Only Button sets an `icon…` data-size. */
const COARSE_ICON_GROUP = "pointer-coarse:gap-1 pointer-coarse:[&_[data-size^=icon]]:size-10"

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  inForm = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    /** Sits among form fields (U4 §11.3): grows on coarse pointers instead of taking an expander. */
    inForm?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(
        buttonVariants({ variant, size }),
        inForm ? IN_FORM : EXPANDED.has(size ?? "default") && "relative hit-40",
        className
      )}
      {...props}
    />
  )
}

export { Button, buttonVariants, COARSE_ICON_GROUP, IN_FORM }
