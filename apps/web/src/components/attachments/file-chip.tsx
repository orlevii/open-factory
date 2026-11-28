import type { MessageAttachment } from "@open-factory/shared";
import { File, FileText, Image as ImageIcon } from "lucide-react";
import type { ReactNode } from "react";
import { displayName } from "@/components/composer/attachments";
import { MiddleTruncate } from "@/components/middle-truncate";
import { formatBytes } from "@/features/session/format";

/** The one chip anatomy (composer and message): a fixed 28px lead, then a name over a second line. */
export function FileChipLead({ children }: { children: ReactNode }) {
  return <span className="size-7 shrink-0 grid place-items-center">{children}</span>;
}

/** The kind's 16px glyph: an image, a text file, or any other file. */
export function KindIcon({ kind }: { kind: MessageAttachment["kind"] | undefined }) {
  const Icon = kind === "image" ? ImageIcon : kind === "text" ? FileText : File;
  return (
    <Icon
      aria-hidden="true"
      data-kind-icon={kind ?? "file"}
      className="size-4 text-muted-foreground"
    />
  );
}

/** Line 1 is the name (a text node, middle-truncated); line 2 is the caller's. */
export function FileChipText({ name, children }: { name: string; children: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span dir="auto" className="min-w-0">
        <MiddleTruncate text={displayName(name)} keepEnd headMin />
      </span>
      {/* A word break for the accessible name; whitespace-only text in a flex column draws nothing. */}{" "}
      {children}
    </span>
  );
}

/** Line 2 as a size, its own left-to-right run so an RTL name never reorders it. */
export function FileChipSize({ bytes }: { bytes: number }) {
  return (
    <span
      dir="ltr"
      data-size
      className="text-xs tabular-nums whitespace-nowrap text-muted-foreground"
    >
      {formatBytes(bytes)}
    </span>
  );
}
