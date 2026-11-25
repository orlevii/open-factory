import type { RowState as RowStateName } from "@open-factory/shared";
import { ArrowUpCircle, CircleAlert, TriangleAlert } from "lucide-react";
import { memo } from "react";
import { Elapsed } from "@/components/elapsed";
import { Spinner } from "@/components/ui/spinner";

type Look = { word: string; icon: "spinner" | "alert" | "update" | "warning" };

/** Each state's word and icon (spec §10.2): a word plus an icon, never colour alone, never signal orange. */
const LOOK: Record<RowStateName, Look> = {
  adding: { word: "Adding…", icon: "spinner" },
  checking: { word: "Checking…", icon: "spinner" },
  missing: { word: "Missing", icon: "alert" },
  unusable: { word: "Unusable", icon: "alert" },
  check_failed: { word: "Couldn't check", icon: "alert" },
  update: { word: "Update available", icon: "update" },
  hidden: { word: "Hidden", icon: "warning" },
};

function StateIcon({ icon }: { icon: Look["icon"] }) {
  switch (icon) {
    case "spinner":
      return <Spinner size="text" className="shrink-0 text-muted-foreground" />;
    case "alert":
      return <CircleAlert aria-hidden="true" className="size-3.5 shrink-0 text-destructive" />;
    case "update":
      return <ArrowUpCircle aria-hidden="true" className="size-3.5 shrink-0 text-info" />;
    case "warning":
      return <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0 text-warning" />;
  }
}

/** A row's one state. Pending states show the elapsed time from the server's `since` after 10 s. */
export const RowState = memo(function RowState({
  state,
  since,
}: {
  state: RowStateName;
  since?: string;
}) {
  const { word, icon } = LOOK[state];
  const pending = icon === "spinner";
  return (
    <span
      className={`flex shrink-0 items-center gap-1.5 text-[0.8125rem] ${pending ? "text-muted-foreground" : ""}`}
    >
      <StateIcon icon={icon} />
      {word}
      {pending && since !== undefined && (
        <span aria-hidden="true" className="text-muted-foreground">
          <Elapsed since={since} hideUnderMs={10_000} />
        </span>
      )}
    </span>
  );
});
