import { Loader2 } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Always next to a pending label; stops under reduced motion (the label carries the meaning).
 *  The "button" variant takes its size from the enclosing Button (per Button size); "text" is for inline text. */
export function Spinner({
  size = "button",
  className,
  ...props
}: { size?: "text" | "button" } & Omit<ComponentProps<typeof Loader2>, "size">) {
  return (
    <Loader2
      aria-hidden="true"
      {...props}
      className={cn("motion-safe:animate-spin", size === "text" && "size-3.5", className)}
    />
  );
}
