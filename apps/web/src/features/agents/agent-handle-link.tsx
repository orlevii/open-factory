import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useRefOfHandle } from "@/features/principals/use-principal";

/**
 * A link to an agent that a server list names by handle (a template's agents, a skill's users): the route is keyed by
 * ref, so the handle is resolved through the principals cache. A handle nobody holds (or not loaded yet) is plain text.
 */
export function AgentHandleLink({
  handle,
  to = "/agents/$ref/chat",
  className = "rounded-sm font-mono text-foreground underline-offset-2 hover:underline",
  children,
}: {
  handle: string;
  to?: "/agents/$ref" | "/agents/$ref/chat";
  className?: string;
  children: ReactNode;
}) {
  const ref = useRefOfHandle()(handle);
  if (!ref) return <span className={className.replace(/\bhover:underline\b/, "")}>{children}</span>;
  return (
    <Link to={to} params={{ ref }} className={className}>
      {children}
    </Link>
  );
}
