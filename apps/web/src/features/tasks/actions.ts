import type { useNavigate } from "@tanstack/react-router";

/** "New task": the palette's action and the `c` shortcut both call this. */
export function newTask(navigate: ReturnType<typeof useNavigate>): void {
  void navigate({ to: "/tasks/new" });
}
