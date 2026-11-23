import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { chatAroundQueryOptions, chatQueryOptions } from "@/features/chat/api";
import { ChatView } from "@/features/chat/chat-view";

export const Route = createFileRoute("/_app/agents/$slug/chat")({
  validateSearch: z.object({
    // A message id: the thread opens around it.
    message: z.string().min(1).optional().catch(undefined),
  }),
  loaderDeps: ({ search }) => ({ message: search.message }),
  // A hover or a navigation starts the thread's fetch. Cached, it refreshes behind what is on screen;
  // uncached, the page waits for it (an error is the view's to show, with its retry).
  loader: async ({ context, params, deps }) => {
    const qc = context.queryClient;
    if (deps.message) {
      const opts = chatAroundQueryOptions(params.slug, deps.message);
      const cached = qc.getQueryData(opts.queryKey) !== undefined;
      const run = qc.prefetchQuery(opts);
      if (!cached) await run;
      return;
    }
    const opts = chatQueryOptions(params.slug);
    const cached = qc.getQueryData(opts.queryKey) !== undefined;
    const run = qc.prefetchInfiniteQuery(opts);
    if (!cached) await run;
  },
  component: function ChatRoute() {
    const { slug } = Route.useParams();
    const { message } = Route.useSearch();
    // A new `?message` remounts the view (never the layout).
    return <ChatView key={`${slug}:${message ?? ""}`} slug={slug} messageId={message} />;
  },
});
