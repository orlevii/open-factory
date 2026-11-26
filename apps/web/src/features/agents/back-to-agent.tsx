import { Link } from "@tanstack/react-router";
import { useHandle } from "@/features/agents/use-agent-index";

/** The way back from an agent's own page (Usage, Configuration) to its Chat: "← @ana". */
export function BackToAgent({
  agentRef,
  handle: known,
}: {
  agentRef: string;
  handle?: string | undefined;
}) {
  const looked = useHandle(agentRef);
  const handle = known ?? looked;
  return (
    <Link
      to="/agents/$ref/chat"
      params={{ ref: agentRef }}
      className="w-fit text-[0.8125rem] leading-[1.125rem] text-muted-foreground hover:text-foreground hover:underline"
    >
      ← @{handle}
    </Link>
  );
}
