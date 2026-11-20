import { Check, Ellipsis, Link2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type CopyState = "idle" | "copied" | "failed";

/** Hover / focus-within icon on fine pointers; an always-visible ⋯ menu on touch (UI design §4.3).
 *  Feedback is inline (no toast): a check, or "Couldn't copy" (no clipboard over plain http). */
export function CopyLink({
  slug,
  seq,
  focusable,
}: {
  slug: string;
  seq: number;
  focusable: boolean;
}) {
  const [state, setState] = useState<CopyState>("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), state === "copied" ? 1500 : 3000);
    return () => clearTimeout(t);
  }, [state]);
  const copy = () => {
    const url = `${location.origin}/agents/${encodeURIComponent(slug)}?event=${seq}`;
    const write = navigator.clipboard?.writeText(url);
    if (!write) return setState("failed");
    write.then(
      () => setState("copied"),
      () => setState("failed"),
    );
  };
  return (
    <>
      <button
        type="button"
        data-copy-link
        tabIndex={focusable ? 0 : -1}
        aria-label={state === "copied" ? "Copied" : "Copy link"}
        onClick={copy}
        className="absolute top-1 right-0 hidden rounded-md p-1 text-muted-foreground group-focus-within:block group-hover:block hover:bg-accent hover:text-foreground pointer-coarse:hidden!"
      >
        {state === "copied" ? (
          <Check aria-hidden="true" className="size-3.5" />
        ) : (
          <Link2 aria-hidden="true" className="size-3.5" />
        )}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Row actions"
          tabIndex={-1}
          className="absolute top-1 right-0 hidden rounded-md p-1 text-muted-foreground pointer-coarse:block"
        >
          <Ellipsis aria-hidden="true" className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={copy}>Copy link</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {state === "failed" && (
        <span className="absolute top-1 right-8 rounded-sm bg-popover px-1.5 text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
          Couldn't copy
        </span>
      )}
    </>
  );
}
