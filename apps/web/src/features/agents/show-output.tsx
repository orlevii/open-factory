import { useSyncExternalStore } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/** A failed command's output, opened from "Show output" on its toast (a failed re-sync's plugin
 *  install, U4 §6.5) or on New agent's outcome line (a failed create's): neither line can hold it. */
type Output = { title: string; description: string; output: string };

let current: Output | null = null;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const set = (o: Output | null) => {
  current = o;
  for (const l of listeners) l();
};
const get = () => current;

/** Opens the output dialog; nothing for an empty output. */
export function showOutput(o: Output) {
  if (o.output.trim() !== "") set(o);
}

/** Whether there is output worth a "Show output" action. */
export const hasOutput = (output: unknown): output is string =>
  typeof output === "string" && output.trim() !== "";

/** Mounted once in the app layout. */
export function OutputDialogHost() {
  const o = useSyncExternalStore(subscribe, get, get);
  return (
    <AlertDialog open={o !== null} onOpenChange={(open) => !open && set(null)}>
      {o && (
        <AlertDialogContent className="sm:max-w-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>{o.title}</AlertDialogTitle>
            <AlertDialogDescription>{o.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <pre className="max-h-[60vh] overflow-auto rounded-md border border-code-border bg-code p-3 font-mono text-xs whitespace-pre-wrap">
            {o.output}
          </pre>
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      )}
    </AlertDialog>
  );
}
