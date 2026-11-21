import { createFileRoute, redirect } from "@tanstack/react-router";

// The Inbox is home: `/` has no page of its own. `replace` keeps Back from bouncing off it.
export const Route = createFileRoute("/_app/")({
  beforeLoad: () => {
    throw redirect({ to: "/inbox", replace: true });
  },
});
