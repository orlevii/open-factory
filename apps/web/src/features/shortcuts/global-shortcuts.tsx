import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { newTask } from "@/features/tasks/actions";
import { useShortcut } from "@/lib/shortcuts";
import { setShortcutsSheetOpen, toggleShortcutsSheet } from "./sheet-store";
import { ShortcutsSheet } from "./shortcuts-sheet";

/** Registers the app-wide single-key bindings (§10.3) and hosts the sheet that lists them. Matching
 *  is on `event.key`, so `?` works on layouts where it needs Shift. */
export function GlobalShortcuts() {
  const navigate = useNavigate();
  useShortcut("g i", () => void navigate({ to: "/inbox" }));
  useShortcut("g t", () => void navigate({ to: "/tasks" }));
  useShortcut("g s", () => void navigate({ to: "/schedules" }));
  useShortcut("g u", () => void navigate({ to: "/usage" }));
  useShortcut("g a", () => void navigate({ to: "/agents" }));
  useShortcut("c", () => newTask(navigate));
  useShortcut("?", toggleShortcutsSheet);
  // Leaving the shell (sign-out) closes it, so the next shell doesn't open with it.
  useEffect(() => () => setShortcutsSheetOpen(false), []);
  return <ShortcutsSheet />;
}
