import { Switch as SwitchPrimitive } from "radix-ui";
import { Kbd } from "@/components/ui/kbd";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { usePref } from "@/lib/prefs";
import { SINGLE_KEYS_PREF } from "@/lib/shortcuts";
import { setShortcutsSheetOpen, useShortcutsSheetOpen } from "./sheet-store";

const GROUPS: { title: string; rows: { label: string; keys: string[] }[] }[] = [
  {
    title: "Global",
    rows: [
      { label: "Search", keys: ["Mod", "K"] },
      { label: "Go to Inbox", keys: ["g", "i"] },
      { label: "Go to Tasks", keys: ["g", "t"] },
      { label: "Go to Skills", keys: ["g", "k"] },
      { label: "Go to Schedules", keys: ["g", "s"] },
      { label: "Go to Usage", keys: ["g", "u"] },
      { label: "Go to Agents", keys: ["g", "a"] },
      { label: "New task", keys: ["c"] },
      { label: "Keyboard shortcuts", keys: ["?"] },
    ],
  },
  {
    title: "Lists",
    rows: [
      { label: "Next row", keys: ["j"] },
      { label: "Previous row", keys: ["k"] },
      { label: "Open row", keys: ["Enter"] },
      { label: "Select or peek row", keys: ["Space"] },
    ],
  },
  { title: "Session", rows: [{ label: "Agent details", keys: ["]"] }] },
];

/** The sheet's content id: `?` may fire behind it when it is the open modal (the phone drawer). */
export const SHORTCUTS_SHEET_ID = "shortcuts-sheet";

const parseOn = (raw: string) => raw !== "off";
const serializeOn = (on: boolean) => (on ? "on" : "off");

/** `?` and the palette's "Keyboard shortcuts" open it: a peek that leaves the page (and the
 *  single-key shortcuts) usable behind it. The switch is WCAG 2.1.4's way to turn them off. */
export function ShortcutsSheet() {
  const open = useShortcutsSheetOpen();
  const [on, setOn] = usePref(SINGLE_KEYS_PREF, true, parseOn, serializeOn);
  return (
    <Sheet open={open} onOpenChange={setShortcutsSheetOpen} modal={false}>
      <SheetContent id={SHORTCUTS_SHEET_ID} aria-describedby={undefined}>
        <SheetHeader>
          <SheetTitle>Keyboard shortcuts</SheetTitle>
        </SheetHeader>
        <SheetBody className="flex flex-col gap-6">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span id="single-keys-label">Single-key shortcuts</span>
            <SwitchPrimitive.Root
              aria-labelledby="single-keys-label"
              checked={on}
              onCheckedChange={setOn}
              className="relative h-5 w-9 shrink-0 rounded-full border bg-muted transition-colors data-[state=checked]:border-primary data-[state=checked]:bg-primary"
            >
              <SwitchPrimitive.Thumb className="block size-4 translate-x-0.5 rounded-full bg-background shadow-sm transition-transform data-[state=checked]:translate-x-[1.125rem]" />
            </SwitchPrimitive.Root>
          </div>
          {GROUPS.map((g) => (
            <section key={g.title} aria-label={g.title} className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">{g.title}</h3>
              <ul className="flex flex-col gap-1.5">
                {g.rows.map((r) => (
                  <li key={r.label} className="flex items-center justify-between gap-3 text-sm">
                    <span>{r.label}</span>
                    <Kbd keys={r.keys} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
