import { createFileRoute } from "@tanstack/react-router";
import { openSheet } from "@/features/sheets/sheet-store";
import { MarketplaceList } from "@/features/skills/marketplace-list";
import { PeekPage } from "@/features/skills/peek-page";
import { MARKETPLACES_ARRIVAL } from "@/features/skills/use-library-arrival";
import { marketplacesQueryOptions } from "@/lib/library";

export const Route = createFileRoute("/_app/skills/marketplaces")({
  loader: async ({ context, preload }) => {
    const qc = context.queryClient;
    await Promise.allSettled([
      preload
        ? qc.ensureQueryData(marketplacesQueryOptions)
        : qc.fetchQuery(marketplacesQueryOptions),
    ]);
  },
  component: MarketplacesPage,
});

function MarketplacesPage() {
  return (
    <PeekPage
      view="marketplaces"
      arrivalView={MARKETPLACES_ARRIVAL}
      onAdd={() => openSheet({ kind: "add-marketplace" })}
      list={(p) => <MarketplaceList {...p} />}
    />
  );
}
