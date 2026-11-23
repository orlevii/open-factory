import { Link } from "@tanstack/react-router";
import { MessageSquare, SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { AgentView } from "./view-memory";

/** The view you would switch to: its label, what it opens, and its icon. */
const OTHER = {
  chat: {
    to: "/agents/$slug/session",
    label: "Session",
    opens: "Open session",
    Icon: SquareTerminal,
  },
  session: { to: "/agents/$slug/chat", label: "Chat", opens: "Open chat", Icon: MessageSquare },
} as const;

/** The other view's name and menu wording, for the ⋯ menu's copy of the switch. */
export const viewSwitchTarget = (view: AgentView) => OTHER[view];

/**
 * The header's Chat ↔ Session switch (spec §6.2): navigation, so a ghost button with icon and label. Its
 * slot keeps the width of the wider label (the other one is laid over it, hidden), so it never moves
 * between views. Below a 24rem header only the icon shows, the label is its accessible name and its
 * tooltip. When the header is crowded (`inMenu`) it hides below 22rem: the ⋯ menu then carries it.
 */
export function ViewSwitch({
  slug,
  view,
  inMenu = false,
}: {
  slug: string;
  view: AgentView;
  inMenu?: boolean;
}) {
  const to = OTHER[view];
  const other = OTHER[view === "chat" ? "session" : "chat"];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          asChild
          variant="ghost"
          size="default"
          className={cn("@max-[24rem]:px-0 @max-[24rem]:w-8", inMenu && "@max-[22rem]:hidden")}
        >
          <Link data-view-switch to={to.to} params={{ slug }} aria-label={to.label}>
            <to.Icon aria-hidden="true" />
            {/* Both labels share one grid cell: the wider sets the width, the other is never seen. */}
            <span className="grid @max-[24rem]:sr-only">
              <span className="col-start-1 row-start-1">{to.label}</span>
              <span aria-hidden="true" className="invisible col-start-1 row-start-1">
                {other.label}
              </span>
            </span>
          </Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{to.opens}</TooltipContent>
    </Tooltip>
  );
}
