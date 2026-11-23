import { isHostPathShape, MSG } from "@open-factory/shared";
import type { ComponentProps } from "react";
import { FormField } from "@/components/form-field";
import { PathHelp } from "@/components/path-help";
import { FORM_MSG } from "@/lib/form-messages";
import { cn } from "@/lib/utils";

/** The shape check for a path on the factory's machine; the server expands `~` and checks the folder. */
export const checkHostPath = (p: string) => {
  const t = p.trim();
  if (t === "") return FORM_MSG.enterPath;
  return isHostPathShape(t) ? undefined : MSG.hostPathStart;
};

type Props = Omit<ComponentProps<typeof FormField>, "action" | "help"> & { help: string };

/** Hoisted: a prop-less element reused on every render, so a keystroke in the field never re-renders the popover. */
const PATH_HELP = <PathHelp />;

/** A field for a folder on the factory's machine (Projects now; I5's local folders later). */
export function PathField({ className, ...props }: Props) {
  return (
    <FormField
      autoComplete="off"
      autoCapitalize="none"
      spellCheck={false}
      {...props}
      className={cn("font-mono", className)}
      action={PATH_HELP}
    />
  );
}
