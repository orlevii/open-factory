import * as React from "react"
import { cn } from "cn"
import { Command as CommandPrimitive, defaultFilter } from "cmdk"
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react"
import { lastInputModality } from "@/lib/input-modality"
import { Popover, PopoverContent, PopoverTrigger } from "./popover"
import { selectTriggerClass } from "./select"

export type ComboOption = {
  value: string
  label: string
  keywords?: string[]
  group?: string
  disabled?: boolean
  /** Kept first and shown whatever the filter ("None", "Anyone"). */
  fixed?: boolean
}

type Side = "top" | "right" | "bottom" | "left"

// A cmdk item's value is our option value behind a prefix that says whether it is fixed, so the
// module-level filter keeps fixed options by looking at the value alone (no closure over props).
const FIXED = "f:"
const itemKey = (o: ComboOption) => (o.fixed ? FIXED : "o:") + o.value

/** Fixed options always match with cmdk's top score, so its re-sort keeps them first; the rest
 *  match on their label (the first keyword) and then their keywords. */
function filter(value: string, search: string, keywords?: string[]) {
  if (value.startsWith(FIXED)) return 1
  const [label = "", ...rest] = keywords ?? []
  return defaultFilter(label, search, rest)
}

/** Fixed options first, then the current value, then the rest in their order. Grouped options keep
 *  their group (groups in first-seen order, after the ungrouped ones). */
function arrange(options: ComboOption[], value: string) {
  const fixed: ComboOption[] = []
  const current: ComboOption[] = []
  const rest: ComboOption[] = []
  for (const o of options) (o.fixed ? fixed : o.value === value ? current : rest).push(o)
  const loose: ComboOption[] = []
  const groups = new Map<string, ComboOption[]>()
  for (const o of options) if (o.group && !groups.has(o.group)) groups.set(o.group, [])
  for (const o of [...fixed, ...current, ...rest]) {
    if (o.group) groups.get(o.group)?.push(o)
    else loose.push(o)
  }
  return { loose, groups: [...groups] }
}

const inputClass =
  "h-full min-w-0 flex-1 bg-transparent text-sm outline-hidden placeholder:text-muted-foreground" // ui-contract:allow the filter field is the popover's only field and opens focused; its caret marks it

const itemClass =
  "relative flex min-h-8 pointer-coarse:min-h-9 cursor-default items-center gap-2 rounded-md py-1.5 pr-8 pl-2 text-sm select-none [overflow-wrap:anywhere] data-[selected=true]:bg-accent data-[disabled=true]:pointer-events-none data-[disabled=true]:text-muted-foreground"

const groupClass =
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground"

function ComboItem({
  option,
  selected,
  onCommit,
  renderOption,
}: {
  option: ComboOption
  selected: boolean
  onCommit: (value: string) => void
  renderOption?: ((option: ComboOption) => React.ReactNode) | undefined
}) {
  return (
    <CommandPrimitive.Item
      value={itemKey(option)}
      keywords={[option.label, ...(option.keywords ?? [])]}
      disabled={option.disabled}
      onSelect={() => onCommit(option.value)}
      className={itemClass}
    >
      <span className="min-w-0 flex-1 truncate">{renderOption ? renderOption(option) : option.label}</span>
      <span className="absolute right-2 flex size-4 items-center justify-center">
        {selected ? <CheckIcon className="size-4 text-foreground" /> : null}
      </span>
    </CommandPrimitive.Item>
  )
}

/** Mounted only while open, so the arranging runs per opening, not on every parent render. */
function ComboList({
  options,
  value,
  emptyText,
  onCommit,
  onSearch,
  renderOption,
}: {
  options: ComboOption[]
  value: string
  emptyText?: string
  onCommit: (value: string) => void
  onSearch: () => void
  renderOption?: ((option: ComboOption) => React.ReactNode) | undefined
}) {
  const { loose, groups } = React.useMemo(() => arrange(options, value), [options, value])
  const current = options.find((o) => o.value === value)
  const [search, setSearch] = React.useState("")
  const [highlight, setHighlight] = React.useState(current ? itemKey(current) : "")
  // Fixed options stay on top while filtering (score 1), so cmdk's "highlight the first row" would pick
  // "None" and Enter would commit it. While the highlight is cmdk's own (no arrow or pointer move since the
  // last keystroke), a fixed row is swapped for the best real match.
  const moved = React.useRef(false)
  // Two steps (the fixed key lands in state first, then the swap) so cmdk, which only follows a changed
  // `value` prop, is told again each time it re-highlights the fixed row.
  React.useEffect(() => {
    if (moved.current || !search || !highlight.startsWith(FIXED)) return
    let best: { key: string; score: number } | undefined
    for (const o of options) {
      if (o.fixed || o.disabled) continue
      const score = filter(itemKey(o), search, [o.label, ...(o.keywords ?? [])])
      if (score > 0 && (!best || score > best.score)) best = { key: itemKey(o), score }
    }
    if (best) setHighlight(best.key)
  }, [highlight, search, options])
  const item = (o: ComboOption) => (
    <ComboItem
      key={itemKey(o)}
      option={o}
      selected={o.value === value}
      onCommit={onCommit}
      renderOption={renderOption}
    />
  )
  return (
    <CommandPrimitive
      label="Search"
      filter={filter}
      value={highlight}
      onValueChange={setHighlight}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") moved.current = true
      }}
      className="flex flex-col"
    >
      <div className="flex h-9 items-center gap-2 border-b border-border px-2.5">
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
        <CommandPrimitive.Input
          placeholder="Search…"
          onValueChange={(s) => {
            moved.current = false
            setSearch(s)
            onSearch()
          }}
          className={inputClass}
        />
      </div>
      {/* A fixed height: the popover doesn't resize as the filter narrows, and nothing animates it. */}
      <CommandPrimitive.List onPointerMove={() => (moved.current = true)} className="h-72 overflow-y-auto overscroll-contain scroll-py-1 p-1">
        <CommandPrimitive.Empty className="py-6 text-center text-sm text-muted-foreground">
          {emptyText}
        </CommandPrimitive.Empty>
        {/* Ungrouped options sit in a heading-less group: cmdk's re-sort appends loose items after
            every group, which would push fixed options below a group while filtering. */}
        <CommandPrimitive.Group>{loose.map(item)}</CommandPrimitive.Group>
        {groups.map(([group, members]) => (
          <CommandPrimitive.Group key={group} heading={group} className={groupClass}>
            {members.map(item)}
          </CommandPrimitive.Group>
        ))}
      </CommandPrimitive.List>
    </CommandPrimitive>
  )
}

/** A searchable pick that looks exactly like a Select. Arrow keys move the highlight; only Enter
 *  or a click commits (DESIGN.md → Combobox). */
function Combobox({
  value,
  onValueChange,
  options,
  placeholder,
  emptyText,
  "aria-label": ariaLabel,
  "aria-invalid": ariaInvalid,
  "aria-describedby": ariaDescribedBy,
  id,
  disabled,
  renderOption,
  renderValue,
  triggerClassName,
  onOpen,
  onBlur,
}: {
  value: string
  onValueChange: (value: string) => void
  options: ComboOption[]
  placeholder?: string
  emptyText?: string
  "aria-label": string
  "aria-invalid"?: boolean | undefined
  "aria-describedby"?: string | undefined
  id?: string | undefined
  disabled?: boolean | undefined
  /** One row renderer for every option (a stable function, not a closure per option); defaults to the label. */
  renderOption?: (option: ComboOption) => React.ReactNode
  renderValue?: (value: string) => React.ReactNode
  triggerClassName?: string
  /** Called each time the popover opens (for work that should wait for the first look). */
  onOpen?: () => void
  onBlur?: () => void
}) {
  const [open, setOpen] = React.useState(false)
  // Once the filter is used, the popover's placement is frozen so it never flips while open: the side
  // it landed on, plus how far collision shift had moved it along the trigger (as an alignment offset,
  // since locking turns collision handling, flip and shift alike, off).
  const [lock, setLock] = React.useState<{ side: Side; offset: number }>()
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)

  const selected = options.find((o) => o.value === value)
  const empty = !selected && value === ""
  const shown = empty ? placeholder : renderValue ? renderValue(value) : (selected?.label ?? value)

  const onOpenChange = (next: boolean) => {
    setOpen(next)
    // Reset on open, not on close, so a locked popover doesn't jump while it fades out.
    if (next) {
      setLock(undefined)
      onOpen?.()
    }
  }
  const lockPlacement = () => {
    const content = contentRef.current
    const side = content?.getAttribute("data-side") as Side | null | undefined
    if (lock || !content || !side) return
    const c = content.getBoundingClientRect()
    const t = triggerRef.current?.getBoundingClientRect()
    const along = side === "top" || side === "bottom" ? "left" : "top"
    setLock({ side, offset: t ? c[along] - t[along] : 0 })
  }
  // A key that closes an overlay closes it at once (DESIGN.md → Motion).
  const stampInstant = () => contentRef.current?.setAttribute("data-instant", "")
  const commit = (next: string) => {
    if (lastInputModality() === "keyboard") stampInstant()
    onOpenChange(false)
    onValueChange(next)
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          id={id}
          disabled={disabled}
          onBlur={onBlur}
          aria-label={ariaLabel}
          aria-invalid={ariaInvalid}
          aria-describedby={ariaDescribedBy}
          data-slot="combobox-trigger"
          data-placeholder={empty ? "" : undefined}
          className={cn(selectTriggerClass, triggerClassName)}
          // Like a Select, an arrow key opens it (the input-modality listener stamps it instant).
          onKeyDown={(e) => {
            if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault()
              onOpenChange(true)
            }
          }}
          ref={triggerRef}
        >
          {/* A flex item that shrinks below its content and clips it: text gets its own ellipsis and a
              rendered value (an agent chip) shrinks with the slot, so its parts truncate. `relative`
              keeps the content's sr-only (absolute) spans inside the clip, off the page's width. */}
          <span data-slot="combobox-value" className="relative flex min-w-0 flex-1 overflow-hidden">
            {typeof shown === "string" ? <span className="truncate">{shown}</span> : shown}
          </span>
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        align="start"
        side={lock?.side}
        alignOffset={lock?.offset ?? 0}
        avoidCollisions={!lock}
        onEscapeKeyDown={stampInstant}
        className="w-[max(var(--radix-popover-trigger-width),min(24rem,calc(100vw-2rem)))] gap-0 p-0"
      >
        <ComboList
          options={options}
          value={value}
          emptyText={emptyText}
          onCommit={commit}
          onSearch={lockPlacement}
          renderOption={renderOption}
        />
      </PopoverContent>
    </Popover>
  )
}

export { Combobox }
