import { useQuery } from "@tanstack/react-query";
import { CircleHelp } from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { hostQueryOptions } from "@/lib/host";

/** "How do I find this path?" for a field that takes a path on the factory's machine (spec §5.3). */
export function PathHelp() {
  const [open, setOpen] = useState(false);
  // Tab has nowhere to go in a popover with no controls: close it. Radix's non-modal close refocuses
  // the trigger (onCloseAutoFocus), so no explicit focus() here.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    e.preventDefault();
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          inForm
          data-skip-validate
          className="text-muted-foreground hover:text-foreground aria-expanded:text-foreground"
        >
          <CircleHelp aria-hidden="true" data-icon="inline-start" />
          How do I find this path?
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={8}
        onKeyDown={onKeyDown}
        className="w-80 max-w-[calc(100vw-1rem)] text-[0.8125rem] leading-[1.125rem]"
      >
        <PathHelpContent />
      </PopoverContent>
    </Popover>
  );
}

const CODE = "font-mono [overflow-wrap:anywhere]";

/** Mounted only while open, so the host query runs on first open at the latest; a failed one refetches next open. */
function PathHelpContent() {
  const { data: host } = useQuery(hostQueryOptions);
  return (
    <>
      <PopoverTitle className="sr-only">How to find a path</PopoverTitle>
      <PopoverDescription className="text-muted-foreground">
        {host ? (
          <>
            Paths are on <strong className={CODE}>{host.hostname}</strong>, the factory's machine.{" "}
            <code className="font-mono">~</code> means <code className={CODE}>{host.home}</code>.
          </>
        ) : (
          "Paths are on the factory's machine."
        )}
      </PopoverDescription>
      {host ? (
        host.platform === "darwin" ? (
          <MacSteps />
        ) : (
          <LinuxSteps />
        )
      ) : (
        <>
          <p className="text-xs text-muted-foreground">macOS</p>
          <MacSteps />
          <p className="text-xs text-muted-foreground">Linux</p>
          <LinuxSteps />
        </>
      )}
    </>
  );
}

function MacSteps() {
  return (
    <ul className="grid gap-1">
      <li className="leading-6">
        In Finder, select the folder and press <Kbd keys={["⌥", "⌘", "C"]} /> to copy its path.
      </li>
      <li>Or drag the folder into Terminal to paste its path.</li>
      <li>
        Or run <code className="font-mono">pwd</code> in a terminal opened in the folder.
      </li>
    </ul>
  );
}

function LinuxSteps() {
  return (
    <ul className="grid gap-1">
      <li>
        Run <code className="font-mono">pwd</code> in a terminal opened in the folder.
      </li>
      <li className="leading-6">
        In the file manager, press <Kbd keys={["Ctrl", "L"]} /> and copy the location.
      </li>
    </ul>
  );
}
