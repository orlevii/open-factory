import { Link } from "@tanstack/react-router";

/** "← Schedules": the back link above the create and edit pages. */
export function BackLink() {
  return (
    <Link
      to="/schedules"
      search={{}}
      className="w-fit text-[0.8125rem] leading-[1.125rem] text-muted-foreground hover:text-foreground hover:underline"
    >
      ← Schedules
    </Link>
  );
}
