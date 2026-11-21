import { ApiError } from "@open-factory/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initTheme } from "./lib/theme";
import { createAppRouter } from "./router";
import "./styles.css";

initTheme();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Loader-prefetched data is fresh on mount instead of refetched; WebSocket events invalidate
      // whatever changes on the server, so a short window is enough.
      staleTime: 30_000,
      // A 4xx won't change on retry: show it now. Network and 5xx failures still retry.
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 3,
    },
  },
});
const router = createAppRouter(queryClient);

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing");
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
