import { Link } from "@tanstack/react-router";

/** The way back from an agent's own page (Usage, Configuration) to its Chat: "← @ana". */
export function BackToAgent({ slug }: { slug: string }) {
  return (
    <Link
      to="/agents/$slug/chat"
      params={{ slug }}
      className="w-fit text-[0.8125rem] leading-[1.125rem] text-muted-foreground hover:text-foreground hover:underline"
    >
      ← @{slug}
    </Link>
  );
}
