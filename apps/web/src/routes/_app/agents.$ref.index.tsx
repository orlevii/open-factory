import { createFileRoute, redirect } from "@tanstack/react-router";

// An agent opens as its chat; the session is one switch away (spec §6.1).
export const Route = createFileRoute("/_app/agents/$ref/")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/agents/$ref/chat", params, replace: true });
  },
});
