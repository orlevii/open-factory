import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/** Always next to a pending label; stops under reduced motion (the label carries the meaning). */
export function Spinner({
  size = "button",
  className,
}: {
  size?: "text" | "button";
  className?: string;
}) {
  return (
    <Loader2
      aria-hidden="true"
      className={cn("motion-safe:animate-spin", size === "text" ? "size-3.5" : "size-4", className)}
    />
  );
}
