import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { chatAroundQueryOptions, chatQueryOptions } from "@/features/chat/api";
import { ChatView } from "@/features/chat/chat-view";
import { refreshChat } from "@/features/chat/use-chat";

export const Route = createFileRoute("/_app/agents/$ref/chat")({
  validateSearch: z.object({
    // A message id: the thread opens around it.
    message: z.string().min(1).optional().catch(undefined),
  }),
  loaderDeps: ({ search }) => ({ message: search.message }),
  // A hover or a navigation starts the thread's fetch. Cached, the newest page refreshes behind what
  // is on screen (through the union); uncached, the page waits for it (an error is the view's to
  // show, with its retry).
  loader: async ({ context, params, deps }) => {
    const qc = context.queryClient;
    const opts = deps.message
      ? chatAroundQueryOptions(params.ref, deps.message)
      : chatQueryOptions(params.ref);
    if (qc.getQueryData(opts.queryKey) === undefined) {
      await qc.prefetchInfiniteQuery(opts);
      return;
    }
    if (!deps.message) void refreshChat(qc, params.ref, "other");
  },
  component: function ChatRoute() {
    const { ref: agentRef } = Route.useParams();
    const { message } = Route.useSearch();
    // A new `?message` remounts the view (never the layout).
    return (
      <ChatView key={`${agentRef}:${message ?? ""}`} agentRef={agentRef} messageId={message} />
    );
  },
});
