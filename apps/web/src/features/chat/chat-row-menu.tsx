import type { ChatEntry } from "@open-factory/shared";
import { type Ref, useCallback } from "react";
import { formatTime } from "@/features/session/format";
import { RowMenu, type RowMenuHandle, type RowMenuItem } from "@/features/session/row-menu";

export type MessageEntry = Extract<ChatEntry, { kind: "message" }>;

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/** The chat row's menu (I1 §6.4): Copy text, Copy link, View in session (a delivered message is in
 *  the session), Recipients when the message went to others too, and the time on touch. */
export function chatMenuItems(
  entry: MessageEntry,
  slug: string,
  others: readonly string[],
): RowMenuItem[] {
  const items: RowMenuItem[] = [
    { kind: "copy", label: "Copy text", text: entry.body },
    {
      kind: "copy",
      label: "Copy link",
      text: `${location.origin}/agents/${encodeURIComponent(slug)}/chat?message=${encodeURIComponent(entry.id)}`,
    },
  ];
  if (entry.state === "delivered")
    items.push({ kind: "session", label: "View in session", to: slug, messageId: entry.id });
  if (others.length > 0)
    items.push({ kind: "recipients", label: "Recipients", text: entry.recipients.join(", ") });
  items.push({ kind: "time", label: `Sent ${clock(entry.createdAt)}` });
  return items;
}

/** The one ⋯ of a chat row, built from the shared row menu. The list is built when the menu first opens. */
export function ChatRowMenu({
  entry,
  slug,
  others,
  tabbable,
  menuRef,
}: {
  entry: MessageEntry;
  slug: string;
  others: readonly string[];
  tabbable: boolean;
  menuRef: Ref<RowMenuHandle>;
}) {
  const items = useCallback(() => chatMenuItems(entry, slug, others), [entry, slug, others]);
  const title = useCallback(
    () => `Message from ${entry.from} · ${formatTime(entry.createdAt)}`,
    [entry.from, entry.createdAt],
  );
  return <RowMenu ref={menuRef} items={items} title={title} focusable={tabbable} />;
}
