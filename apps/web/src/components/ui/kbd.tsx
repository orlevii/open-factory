import { cn } from "@/lib/utils";

/** ⌘ platforms: the palette binds ⌘K there and Ctrl+K elsewhere. */
export const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Key caps for a shortcut hint: `<Kbd keys={["Mod", "K"]} />`. "Mod" is ⌘ on Apple platforms, else Ctrl. */
export function Kbd({ keys, className }: { keys: string[]; className?: string }) {
  const mac = isMac();
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {keys.map((k, i) => (
        <kbd
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed, short list that never reorders
          key={i}
          className="inline-flex h-5 min-w-5 items-center justify-center rounded border bg-muted px-1 font-sans text-[0.6875rem] font-medium text-muted-foreground"
        >
          {k === "Mod" ? (mac ? "⌘" : "Ctrl") : k}
        </kbd>
      ))}
    </span>
  );
}
