import { usageDaysSchema } from "@open-factory/shared";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

const SECTIONS = ["credentials", "secrets", "projects", "users", "factory"] as const;
type Section = (typeof SECTIONS)[number];
const isSection = (h: string): h is Section => (SECTIONS as readonly string[]).includes(h);

// `/settings` is only a door: every link that predates the per-section pages (a bookmark, a hash,
// ?addSecret=, ?days=) lands on the page that now holds it. Nothing renders here.
export const Route = createFileRoute("/_app/settings/")({
  validateSearch: z.object({
    addSecret: z.string().optional().catch(undefined),
    days: usageDaysSchema.optional().catch(undefined),
  }),
  beforeLoad: ({ search, location }) => {
    const hash = location.hash;
    if (hash === "usage" || (!isSection(hash) && search.days !== undefined)) {
      throw redirect({
        to: "/usage",
        search: search.days === undefined ? {} : { days: search.days },
        replace: true,
      });
    }
    if (hash === "secrets") {
      throw redirect({
        to: "/settings/secrets",
        search: search.addSecret === undefined ? {} : { addSecret: search.addSecret },
        replace: true,
      });
    }
    throw redirect({
      to: isSection(hash) ? `/settings/${hash}` : "/settings/credentials",
      replace: true,
    });
  },
});
