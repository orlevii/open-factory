import type { AnyRouter } from "@tanstack/react-router";
import { openSheet } from "@/features/sheets/sheet-store";

const SESSION = /^\/agents\/([^/]+)(?:\/|$)/;

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * "New task": the palette's action, the `c` shortcut and the Tasks header all call this. Where you are decides the
 * assignee: in a session, that agent; on the Tasks list, its `assignee` filter. Read at call time from the router, so
 * the caller subscribes to nothing.
 */
export function newTask(router: AnyRouter): void {
  const { pathname, search } = router.state.location;
  const session = SESSION.exec(pathname)?.[1];
  const filter = (search as { assignee?: unknown }).assignee;
  const onTasks = pathname === "/tasks" || pathname.startsWith("/tasks/");
  const assignee =
    session && session !== "new"
      ? safeDecode(session)
      : onTasks && typeof filter === "string" && filter
        ? filter
        : undefined;
  openSheet({ kind: "new-task", ...(assignee ? { assignee } : {}) });
}
