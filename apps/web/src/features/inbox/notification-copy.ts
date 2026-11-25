import type { ChatRow, InboxItem } from "@open-factory/shared";

/** The hold a `loop_held` notice is about (I8 PR 3, spec §6.4). */
export type LoopHold = {
  id: string;
  agents: [
    { slug: string; status: "live" | "archived" | "terminated" },
    { slug: string; status: "live" | "archived" | "terminated" },
  ];
  waiting: number;
  sentOn: number;
  resumedAt: string | null;
  resumedBy: string | null;
};

/** Until PR 3 adds `inboxItemSchema.loopHold`, the notifier's item is the shared one plus the hold's shape. */
export type NotifiableItem = InboxItem & { loopHold?: LoopHold };
export type NotifiableChat = ChatRow;

export type Burst = {
  key: string;
  tag: string;
  title: string;
  body: string;
  newestId: string;
  itemIds: string[];
  open: { to: string; search?: Record<string, string | number> };
  resolved?: boolean;
};

const PLURAL = new Intl.PluralRules("en");
const NUM = new Intl.NumberFormat();
const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

const TITLE_MAX = 40;

/** Handles are middle-truncated (the `@` and the tail stay readable); names end-truncated. Both at 40 characters. */
export function capTitle(s: string, kind: "handle" | "name"): string {
  if (s.length <= TITLE_MAX) return s;
  if (kind === "name") return `${s.slice(0, TITLE_MAX - 1)}…`;
  const head = 20;
  const tail = TITLE_MAX - 1 - head;
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

const counted = (n: number, one: string, many: (formatted: string) => string) =>
  PLURAL.select(n) === "one" ? one : many(NUM.format(n));

const chatBurst = (c: NotifiableChat): Burst => {
  const slug = c.agent.slug;
  return {
    key: `chat:${slug}`,
    tag: `chat:${slug}:${c.firstUnreadId}`,
    title: capTitle(c.agent.displayName, "name"),
    body: counted(c.unread, "1 new message", (n) => `${n} new messages`),
    newestId: c.latest.messageId,
    itemIds: [],
    open: { to: `/agents/${slug}/chat`, search: { message: c.firstUnreadId } },
  };
};

type Kind = "loop" | "error" | "credential" | "task";
type Group = { kind: Kind; items: NotifiableItem[] };

/** The burst key an unread item belongs to, or undefined when no notification is fired for it. */
function groupOf(i: NotifiableItem): { id: string; kind: Kind } | undefined {
  if (i.notice === "loop_held" && i.loopHold) return { id: `loop:${i.loopHold.id}`, kind: "loop" };
  if (i.notice === "agent_errored" && i.about) return { id: `error:${i.about}`, kind: "error" };
  if (i.kind === "credential" && i.credential)
    return { id: `credential:${i.credential.name}`, kind: "credential" };
  if (i.kind === "mention" && i.task) return { id: `task:${i.task.key}`, kind: "task" };
  return undefined;
}

const byCreatedAt = (a: NotifiableItem, b: NotifiableItem) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

function itemBurst(key: string, kind: Kind, sorted: NotifiableItem[]): Burst | undefined {
  const oldest = sorted[0];
  const newest = sorted[sorted.length - 1];
  if (!oldest || !newest) return undefined;
  const itemIds = sorted.map((i) => i.id);
  const tag = `${key}:${oldest.id}`;
  switch (kind) {
    case "loop": {
      const hold = oldest.loopHold;
      if (!hold) return undefined;
      const [a, b] = hold.agents;
      return {
        key,
        tag: key,
        title: capTitle(`@${a.slug} and @${b.slug}`, "handle"),
        body: "Messages between them are held",
        newestId: newest.id,
        itemIds,
        open: { to: "/inbox", search: { item: oldest.id } },
        resolved: hold.resumedAt !== null,
      };
    }
    case "error":
      return {
        key,
        tag,
        title: capTitle(`@${oldest.about}`, "handle"),
        body: "Hit an error",
        newestId: newest.id,
        itemIds,
        open: { to: `/agents/${oldest.about}/session` },
      };
    case "credential": {
      const credential = oldest.credential;
      if (!credential || credential.expiresAt === null) return undefined;
      const expires = new Date(credential.expiresAt);
      const expired = expires.getTime() < Date.now();
      return {
        key,
        tag,
        title: capTitle(`Credential "${credential.name}"`, "name"),
        body: `${expired ? "Expired" : "Expires"} ${DAY.format(expires)}`,
        newestId: newest.id,
        itemIds,
        open: { to: "/settings/credentials", search: { credential: credential.name } },
      };
    }
    case "task": {
      const taskKey = oldest.task?.key;
      if (!taskKey) return undefined;
      const handles = new Set(sorted.map((i) => i.from.name));
      const title = handles.size === 1 ? `@${oldest.from.name}` : taskKey;
      const comment = oldest.link.kind === "task" ? oldest.link.commentId : undefined;
      return {
        key,
        tag,
        title: capTitle(title, "handle"),
        body: counted(
          sorted.length,
          `Mentioned you on ${taskKey}`,
          (n) => `${n} mentions on ${taskKey}`,
        ),
        newestId: newest.id,
        itemIds,
        open: {
          to: `/tasks/${taskKey}`,
          ...(comment ? { search: { comment } } : {}),
        },
      };
    }
  }
}

/**
 * The notifications the page calls for (spec §5.1): one burst per chat, and per key among the unread items.
 * Copy is the fact only: names, counts, dates. Message text never reaches a title or body.
 */
export function burstsOf(page: { chats: NotifiableChat[]; items: NotifiableItem[] }): Burst[] {
  const out: Burst[] = [];
  for (const c of page.chats) if (c.unread > 0) out.push(chatBurst(c));

  const groups = new Map<string, Group>();
  for (const i of page.items) {
    if (i.read) continue;
    const g = groupOf(i);
    if (!g) continue;
    const group = groups.get(g.id);
    if (group) group.items.push(i);
    else groups.set(g.id, { kind: g.kind, items: [i] });
  }
  for (const [key, group] of groups) {
    const burst = itemBurst(key, group.kind, [...group.items].sort(byCreatedAt));
    if (burst) out.push(burst);
  }
  return out;
}
