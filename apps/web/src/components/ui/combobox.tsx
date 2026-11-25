import * as React from "react"
import { cn } from "cn"
import { Command as CommandPrimitive, defaultFilter } from "cmdk"
import { CheckIcon, ChevronDownIcon, MinusIcon, SearchIcon } from "lucide-react"
import { FORM_MSG } from "@/lib/form-messages"
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
// A multi-pick group's own row ("add the whole group") is keyed by its group behind its own prefix.
const GROUP = "g:"
const itemKey = (o: ComboOption) => (o.fixed ? FIXED : "o:") + o.value
const groupKey = (group: string) => GROUP + group
/** Rows that always match: a fixed option and a group's row. While filtering, neither keeps cmdk's highlight. */
const pinned = (key: string) => key.startsWith(FIXED) || key.startsWith(GROUP)

/** Fixed options always match with cmdk's top score, so its re-sort keeps them first. The rest rank by
 *  their label (the first keyword): the exact label, then a prefix, then a substring, then cmdk's fuzzy
 *  match (a weak tail). The other keywords (a description) match only as a whole-word-run substring, so
 *  a short query doesn't light up every description holding its letters in order. */
function filter(value: string, search: string, keywords?: string[]) {
  // A group's row is rendered only while one of its options matches (ComboList decides), so it always matches.
  if (pinned(value)) return 1
  const [label = "", ...rest] = keywords ?? []
  // A handle is typed with its `@`: it never counts as part of the query.
  const q = search.trim().replace(/^@/, "").toLowerCase()
  if (!q) return 0.5
  const name = label.toLowerCase()
  if (name === q) return 0.99
  if (name.startsWith(q)) return 0.9
  if (name.includes(q)) return 0.8
  const fuzzy = defaultFilter(label, q, [])
  if (fuzzy > 0) return fuzzy * 0.5
  return rest.some((k) => k.toLowerCase().includes(q)) ? 0.4 : 0
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

/** A checkbox's look inside an option (the option is the control, so this draws only the state). Matches
 *  Checkbox: a disabled checked box (an option already added) is muted. */
function CheckMark({ state, disabled }: { state: boolean | "mixed"; disabled: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-checked={state === true ? "" : undefined}
      data-mixed={state === "mixed" ? "" : undefined}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input bg-card [&>svg]:size-3.5",
        "data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground data-mixed:border-primary data-mixed:bg-primary data-mixed:text-primary-foreground",
        disabled && "data-checked:border-transparent data-checked:bg-muted-foreground data-checked:text-card",
      )}
    >
      {state === true ? <CheckIcon /> : state === "mixed" ? <MinusIcon /> : null}
    </span>
  )
}

function ComboItem({
  option,
  selected,
  added,
  checkbox,
  onCommit,
  renderOption,
}: {
  option: ComboOption
  selected: boolean
  /** Multi-pick: this option was picked in this opening; it stays listed, disabled, marked "Added". */
  added: boolean
  /** Multi-pick with group rows: a checkbox on the left says whether it was added, in place of the check. */
  checkbox: boolean
  onCommit: (value: string) => void
  renderOption?: ((option: ComboOption) => React.ReactNode) | undefined
}) {
  if (checkbox)
    return (
      <CommandPrimitive.Item
        value={itemKey(option)}
        keywords={[option.label, ...(option.keywords ?? [])]}
        disabled={option.disabled || added}
        onSelect={() => onCommit(option.value)}
        className={cn(itemClass, "pr-2")}
      >
        <CheckMark state={added} disabled={added} />
        <span className="min-w-0 flex-1 truncate">{renderOption ? renderOption(option) : option.label}</span>
        {added ? <span className="sr-only">, Added</span> : null}
      </CommandPrimitive.Item>
    )
  return (
    <CommandPrimitive.Item
      value={itemKey(option)}
      keywords={[option.label, ...(option.keywords ?? [])]}
      disabled={option.disabled || added}
      onSelect={() => onCommit(option.value)}
      className={itemClass}
    >
      <span className="min-w-0 flex-1 truncate">{renderOption ? renderOption(option) : option.label}</span>
      {added ? <span className="shrink-0 text-xs text-muted-foreground">Added</span> : null}
      <span className="absolute right-2 flex size-4 items-center justify-center">
        {selected || added ? <CheckIcon aria-hidden="true" className="size-4 text-foreground" /> : null}
      </span>
      {/* cmdk's aria-selected marks the highlight, so the current value says so in words. */}
      {selected ? <span className="sr-only">, selected</span> : null}
    </CommandPrimitive.Item>
  )
}

/**
 * A multi-pick group's first row: picking it adds every option of the group that is still addable and matches the
 * filter. Its box is checked once all of them are added and mixed while only some are.
 */
function GroupRow({
  group,
  heading,
  toAdd,
  someAdded,
  onCommit,
}: {
  group: string
  heading: React.ReactNode
  /** The group's options this row would add now. */
  toAdd: string[]
  someAdded: boolean
  onCommit: (group: string, values: string[]) => void
}) {
  const done = toAdd.length === 0
  return (
    <CommandPrimitive.Item
      value={groupKey(group)}
      disabled={done}
      onSelect={() => onCommit(group, toAdd)}
      className={cn(itemClass, "pr-2 font-medium")}
    >
      <CheckMark state={done ? true : someAdded ? "mixed" : false} disabled={done} />
      <span className="flex min-w-0 flex-1">{heading}</span>
      <span className="shrink-0 text-xs font-normal text-muted-foreground">
        {done ? "All added" : `Add ${toAdd.length === 1 ? "1" : `all ${toAdd.length}`}`}
      </span>
    </CommandPrimitive.Item>
  )
}

/** Mounted only while open, so the arranging runs per opening, not on every parent render. */
function ComboList({
  label,
  options,
  value,
  emptyText,
  added,
  groupRows,
  onCommit,
  onCommitGroup,
  onSearch,
  renderOption,
  renderGroup,
  footer,
}: {
  /** The combobox's name, given to the listbox. */
  label: string
  options: ComboOption[]
  value: string
  emptyText?: string
  /** Multi-pick mode: the values picked so far. */
  added?: Set<string> | undefined
  /** Multi-pick mode: each group opens with a row that adds the whole group (and options show checkboxes). */
  groupRows?: boolean
  onCommit: (value: string) => void
  onCommitGroup?: (group: string, values: string[]) => void
  onSearch: () => void
  renderOption?: ((option: ComboOption) => React.ReactNode) | undefined
  renderGroup?: ((group: string) => React.ReactNode) | undefined
  footer?: React.ReactNode
}) {
  const { loose, groups } = React.useMemo(() => arrange(options, value), [options, value])
  const current = options.find((o) => o.value === value)
  const [search, setSearch] = React.useState("")
  // With group rows, the first highlight is the first option, never a group's row: Enter at once adds one skill.
  const firstOption = groupRows ? groups[0]?.[1][0] : undefined
  const [highlight, setHighlight] = React.useState(
    current ? itemKey(current) : firstOption ? itemKey(firstOption) : "",
  )
  // Fixed options stay on top while filtering (score 1), so cmdk's "highlight the first row" would pick
  // "None" and Enter would commit it. While the highlight is cmdk's own (no arrow or pointer move since the
  // last keystroke), a fixed row is swapped for the best real match.
  const moved = React.useRef(false)
  // Two steps (the fixed key lands in state first, then the swap) so cmdk, which only follows a changed
  // `value` prop, is told again each time it re-highlights the fixed row.
  React.useEffect(() => {
    if (moved.current || !search || !pinned(highlight)) return
    let best: { key: string; score: number } | undefined
    for (const o of options) {
      if (o.fixed || o.disabled) continue
      const score = filter(itemKey(o), search, [o.label, ...(o.keywords ?? [])])
      if (score > 0 && (!best || score > best.score)) best = { key: itemKey(o), score }
    }
    if (best) setHighlight(best.key)
  }, [highlight, search, options])
  // A pick in multi mode keeps the popover open, so the highlight (on the row just disabled) moves on
  // to the next enabled row that still matches the filter.
  const commit = (picked: string) => {
    if (added) {
      const flat = [...loose, ...groups.flatMap(([, members]) => members)]
      const from = flat.findIndex((o) => o.value === picked)
      const next = flat
        .slice(from + 1)
        .find(
          (o) =>
            !o.disabled &&
            !added.has(o.value) &&
            (!search || o.fixed || filter(itemKey(o), search, [o.label, ...(o.keywords ?? [])]) > 0),
        )
      if (next) setHighlight(itemKey(next))
    }
    onCommit(picked)
  }
  const item = (o: ComboOption) => (
    <ComboItem
      key={itemKey(o)}
      option={o}
      selected={o.value === value}
      added={added?.has(o.value) ?? false}
      checkbox={!!groupRows}
      onCommit={commit}
      renderOption={renderOption}
    />
  )
  const matches = (o: ComboOption) =>
    !search || filter(itemKey(o), search, [o.label, ...(o.keywords ?? [])]) > 0
  // A group's pick moves the highlight to the first option after the group that can still be added.
  const commitGroup = (group: string, values: string[]) => {
    const at = groups.findIndex(([g]) => g === group)
    const next = groups
      .slice(at + 1)
      .flatMap(([, members]) => members)
      .find((o) => !o.disabled && !added?.has(o.value) && matches(o))
    if (next) setHighlight(itemKey(next))
    onCommitGroup?.(group, values)
  }
  return (
    <CommandPrimitive
      label="Search"
      filter={filter}
      value={highlight}
      onValueChange={setHighlight}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") moved.current = true
      }}
      className="flex min-h-0 flex-col"
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
      <CommandPrimitive.List label={label} onPointerMove={() => (moved.current = true)} className="h-72 min-h-0 overflow-y-auto overscroll-contain scroll-py-1 p-1">
        <CommandPrimitive.Empty className="py-6 text-center text-sm text-muted-foreground">
          {emptyText}
        </CommandPrimitive.Empty>
        {/* Ungrouped options sit in a heading-less group: cmdk's re-sort appends loose items after
            every group, which would push fixed options below a group while filtering. */}
        <CommandPrimitive.Group>{loose.map(item)}</CommandPrimitive.Group>
        {groups.map(([group, members]) => {
          const heading = renderGroup ? renderGroup(group) : group
          if (!groupRows)
            return (
              <CommandPrimitive.Group key={group} heading={heading} className={groupClass}>
                {members.map(item)}
              </CommandPrimitive.Group>
            )
          const shown = members.filter(matches)
          return (
            // The heading still names the group for assistive tech; the group's row shows it.
            <CommandPrimitive.Group
              key={group}
              heading={group}
              className="not-first:mt-1 not-first:border-t not-first:border-border not-first:pt-1 [&_[cmdk-group-heading]]:sr-only"
            >
              {shown.length > 0 ? (
                <GroupRow
                  group={group}
                  heading={heading}
                  toAdd={shown.filter((o) => !o.disabled && !added?.has(o.value)).map((o) => o.value)}
                  someAdded={members.some((o) => added?.has(o.value))}
                  onCommit={commitGroup}
                />
              ) : null}
              {members.map(item)}
            </CommandPrimitive.Group>
          )
        })}
      </CommandPrimitive.List>
      {footer}
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
  pending,
  renderOption,
  renderValue,
  triggerClassName,
  onOpen,
  onClose,
  onBlur,
  multiple,
  trigger,
  renderGroup,
  footer,
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
  /** A commit is saving: the trigger reads as disabled and won't open, but stays focusable, so the
   *  focus the closing popover hands back isn't dropped on <body> (a disabled button can't take it). */
  pending?: boolean | undefined
  /** One row renderer for every option (a stable function, not a closure per option); defaults to the label. */
  renderOption?: (option: ComboOption) => React.ReactNode
  renderValue?: (value: string) => React.ReactNode
  triggerClassName?: string
  /** Called each time the popover opens (for work that should wait for the first look). */
  onOpen?: () => void
  /** Called each time the popover closes (after a pick in single mode, or Escape, outside click). */
  onClose?: () => void
  onBlur?: (e: React.FocusEvent<HTMLButtonElement>) => void
  /** Multi-pick: a pick calls `onValueChange` and `announce("Added <label>")` and keeps the popover open;
   *  picked options stay listed, disabled and marked "Added" until it closes, and are left out the next
   *  time it opens. The list is still a single-select listbox (never aria-multiselectable). */
  multiple?: {
    added: Set<string>
    announce: (label: string) => void
    /** Each group opens with a row that adds all of its options (that match the filter) in one pick, and
     *  options show a checkbox. `onValueChange` is called once per added value. */
    groupRows?: boolean
  }
  /** A caller-supplied trigger (one element) in place of the default Select-shaped button. */
  trigger?: React.ReactElement
  /** A heading per group, in place of its name (a stable function): a long path that truncates in the middle. */
  renderGroup?: (group: string) => React.ReactNode
  /** A muted line under the list (what was left out and why). */
  footer?: React.ReactNode
}) {
  const [open, setOpen] = React.useState(false)
  // Multi-pick: what was already added when the popover opened, left out of its options.
  const [leftOut, setLeftOut] = React.useState<Set<string>>()
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
    if (next && pending) return
    setOpen(next)
    // Reset on open, not on close, so a locked popover doesn't jump while it fades out.
    if (next) {
      setLock(undefined)
      if (multiple) setLeftOut(new Set(multiple.added))
      onOpen?.()
    } else {
      onClose?.()
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
  // Primitives, not the inline `multiple` object, so the list is only filtered again when the options or
  // the opening's snapshot change.
  const isMulti = !!multiple
  const listed = React.useMemo(
    () => (isMulti && leftOut ? options.filter((o) => !leftOut.has(o.value)) : options),
    [options, isMulti, leftOut],
  )
  const commit = (next: string) => {
    if (multiple) {
      lockPlacement()
      multiple.announce(`Added ${options.find((o) => o.value === next)?.label ?? next}`)
      onValueChange(next)
      return
    }
    if (lastInputModality() === "keyboard") stampInstant()
    onOpenChange(false)
    onValueChange(next)
  }

  const commitGroup = (group: string, values: string[]) => {
    if (!multiple || values.length === 0) return
    lockPlacement()
    multiple.announce(`Added ${values.length === 1 ? (options.find((o) => o.value === values[0])?.label ?? values[0]) : `${values.length} from ${group}`}`)
    for (const v of values) onValueChange(v)
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild ref={triggerRef}>
        {trigger ?? (
        <button
          type="button"
          role="combobox"
          id={id}
          disabled={disabled}
          aria-disabled={pending || undefined}
          aria-busy={pending || undefined}
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
        >
          {/* A flex item that shrinks below its content and clips it: text gets its own ellipsis and a
              rendered value (an agent chip) shrinks with the slot, so its parts truncate. `relative`
              keeps the content's sr-only (absolute) spans inside the clip, off the page's width. */}
          <span data-slot="combobox-value" className="relative flex min-w-0 flex-1 overflow-hidden">
            {typeof shown === "string" ? <span className="truncate">{shown}</span> : shown}
          </span>
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
        </button>
        )}
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        align="start"
        side={lock?.side}
        alignOffset={lock?.offset ?? 0}
        avoidCollisions={!lock}
        onEscapeKeyDown={stampInstant}
        aria-label={ariaLabel}
        className="max-h-(--radix-popover-content-available-height) w-[max(var(--radix-popover-trigger-width),min(24rem,calc(100vw-2rem)))] gap-0 p-0"
      >
        <ComboList
          label={ariaLabel}
          options={listed}
          value={value}
          // Multi: once something is listed, an empty result is the filter's, not an empty list.
          emptyText={isMulti && listed.length > 0 ? FORM_MSG.noMatches : emptyText}
          added={multiple?.added}
          groupRows={multiple?.groupRows}
          onCommit={commit}
          onCommitGroup={commitGroup}
          onSearch={lockPlacement}
          renderOption={renderOption}
          renderGroup={renderGroup}
          footer={footer}
        />
      </PopoverContent>
    </Popover>
  )
}

export { Combobox }
