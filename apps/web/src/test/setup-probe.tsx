import { useSetup } from "@/features/setup/api";

/** A mounted reader of the setup query, as the setup checklist is. Its text is the answer it holds. */
export function SetupProbe() {
  const { data } = useSetup();
  return <output aria-label="Setup">{data ? JSON.stringify(data) : "loading"}</output>;
}
