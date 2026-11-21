import { createFileRoute } from "@tanstack/react-router";
import { invitesQueryOptions, usersQueryOptions } from "@/features/settings/api";
import { UsersSection } from "@/features/settings/users-section";

export const Route = createFileRoute("/_app/settings/users")({
  loader: async ({ context }) => {
    const qc = context.queryClient;
    await Promise.allSettled([
      qc.ensureQueryData(usersQueryOptions),
      qc.ensureQueryData(invitesQueryOptions),
    ]);
  },
  component: UsersSection,
});
