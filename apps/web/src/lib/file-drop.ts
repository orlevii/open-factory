const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

/**
 * A file dragged over or dropped anywhere but a drop target (the session composer) would make the browser open it,
 * navigating away from the app (U3 §13.5). The window takes the browser's default for file drags; a drop target that
 * already handled the event (default prevented) keeps its own drop effect. Returns the uninstall.
 */
export function installFileDropGuard(): () => void {
  const over = (e: DragEvent) => {
    if (!carriesFiles(e) || e.defaultPrevented) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
  };
  const drop = (e: DragEvent) => {
    if (carriesFiles(e)) e.preventDefault();
  };
  window.addEventListener("dragover", over);
  window.addEventListener("drop", drop);
  return () => {
    window.removeEventListener("dragover", over);
    window.removeEventListener("drop", drop);
  };
}
