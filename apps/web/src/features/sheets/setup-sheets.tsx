import type { QueryKey } from "@tanstack/react-query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { credentialsQueryOptions, secretsQueryOptions } from "@/features/settings/api";
import { AddCredentialForm } from "@/features/settings/forms/add-credential-form";
import { AddSecretForm } from "@/features/settings/forms/add-secret-form";
import { refreshList, withItem, writeToList } from "./add-to-list";
import { draftGeneration } from "./drafts";
import type { BodyProps } from "./sheet-bodies";
import { completeChild } from "./sheet-store";

/**
 * The top-level Add credential and Add secret sheets (a page opens them for a result): Settings' forms in the sheet frame.
 * On success the item joins its list's cache, then the parent gets the name (`completeChild` drops it when that
 * parent instance has closed, and closes this child when it is still the open one), then the list refetches.
 * Nothing at all happens after a sign-out (the draft generation moved): the item belongs to the old session.
 */
function useFinish(sheetId: number) {
  const qc = useQueryClient();
  // This child's session: a sign-out closes every sheet and bumps the generation.
  const [generation] = useState(draftGeneration);
  return async <I extends { name: string }>(queryKey: QueryKey, item: I) => {
    if (draftGeneration() !== generation) return;
    await writeToList(qc, queryKey, withItem(item));
    if (draftGeneration() !== generation) return;
    completeChild(sheetId, item.name);
    refreshList(qc, queryKey);
  };
}

const names = (list: { name: string }[] | undefined) => list?.map((x) => x.name) ?? [];

export function AddCredentialSheet({ sheetId, close }: BodyProps<{ kind: "add-credential" }>) {
  const credentials = useQuery(credentialsQueryOptions);
  const finish = useFinish(sheetId);
  return (
    <AddCredentialForm
      frame="sheet"
      existing={names(credentials.data)}
      onCancel={close}
      onDone={(c) => void finish(credentialsQueryOptions.queryKey, c)}
    />
  );
}

export function AddSecretSheet({
  spec,
  sheetId,
  close,
}: BodyProps<{ kind: "add-secret"; name: string }>) {
  const secrets = useQuery(secretsQueryOptions);
  const finish = useFinish(sheetId);
  return (
    <AddSecretForm
      frame="sheet"
      initialName={spec.name}
      existing={names(secrets.data)}
      onCancel={close}
      onDone={(s) => void finish(secretsQueryOptions.queryKey, s)}
    />
  );
}
