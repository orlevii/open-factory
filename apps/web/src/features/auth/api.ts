import { apiFetch, signUpStateSchema } from "@open-factory/shared";
import { queryOptions } from "@tanstack/react-query";

/** Whether sign-up is open (bootstrap) and, with an invite, whether that invite is usable. Always refetched. */
export const signUpStateQueryOptions = (invite?: string) =>
  queryOptions({
    queryKey: ["sign-up-state", invite ?? ""],
    queryFn: () => {
      const query = new URLSearchParams(invite ? { invite } : {}).toString();
      return apiFetch(`/api/auth/sign-up-state${query ? `?${query}` : ""}`, {
        schema: signUpStateSchema,
      });
    },
    staleTime: 0,
  });
