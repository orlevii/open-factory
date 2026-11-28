import type { MessageAttachment } from "@open-factory/shared";
import { useState } from "react";
import {
  FileChipLead,
  FileChipSize,
  FileChipText,
  KindIcon,
} from "@/components/attachments/file-chip";
import { displayName } from "@/components/composer/attachments";

/** The upload's same-origin, authenticated URL (the session cookie; never an external host). */
export const uploadUrl = (agentRef: string, uploadId: string) =>
  `/api/agents/${encodeURIComponent(agentRef)}/uploads/${encodeURIComponent(uploadId)}`;

/** Images up to this size preview automatically; a larger one (or one whose size the envelope doesn't carry)
 *  waits for "Show preview", so a timeline never downloads and decodes a 20 MB image to show 28px. */
export const AUTO_PREVIEW_BYTES = 1024 * 1024;

const LINK_CLASS =
  "relative hit-40 flex min-h-9 max-w-[12rem] min-w-0 items-center gap-1.5 rounded-sm border border-border bg-background py-0.5 pr-2 pl-1 text-[0.8125rem] leading-4 text-foreground hover:border-ring";

/** A message's files: an image chip opens in a new tab (and previews); any other file downloads.
 *  The name is a text node, never HTML. */
export function AttachmentList({
  agentRef,
  attachments,
}: {
  agentRef: string;
  attachments: readonly MessageAttachment[];
}) {
  return (
    <ul aria-label="Attached files" className="mt-2 flex flex-wrap gap-1.5">
      {attachments.map((a) => {
        const url = uploadUrl(agentRef, a.uploadId);
        return a.kind === "image" ? (
          <ImageAttachmentChip key={a.uploadId} url={url} attachment={a} />
        ) : (
          <DownloadAttachmentChip key={a.uploadId} url={url} attachment={a} />
        );
      })}
    </ul>
  );
}

function ImageAttachmentChip({
  url,
  attachment: a,
}: {
  url: string;
  attachment: MessageAttachment;
}) {
  const name = displayName(a.name);
  const [asked, setAsked] = useState(false);
  const preview = a.bytes <= AUTO_PREVIEW_BYTES || asked;
  return (
    <li className="flex min-w-0 items-center gap-1">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title={`Open ${name}`}
        data-attachment
        className={LINK_CLASS}
      >
        <span className="sr-only">Open </span>{" "}
        <FileChipLead>
          {preview ? (
            <img
              src={url}
              alt=""
              loading="lazy"
              decoding="async"
              width={28}
              height={28}
              className="size-7 rounded-[3px] object-cover"
            />
          ) : (
            <KindIcon kind="image" />
          )}
        </FileChipLead>
        <FileChipText name={a.name}>
          <FileChipSize bytes={a.bytes} />
        </FileChipText>
      </a>
      {preview ? null : (
        <button
          type="button"
          onClick={() => setAsked(true)}
          aria-label={`Show preview of ${name}`}
          className="text-[0.8125rem] text-muted-foreground underline-offset-4 hover:underline"
        >
          Show preview
        </button>
      )}
    </li>
  );
}

function DownloadAttachmentChip({
  url,
  attachment: a,
}: {
  url: string;
  attachment: MessageAttachment;
}) {
  const name = displayName(a.name);
  return (
    <li className="flex min-w-0 items-center gap-1">
      <a href={url} download title={`Download ${name}`} data-attachment className={LINK_CLASS}>
        <span className="sr-only">Download </span>{" "}
        <FileChipLead>
          <KindIcon kind={a.kind} />
        </FileChipLead>
        <FileChipText name={a.name}>
          <FileChipSize bytes={a.bytes} />
        </FileChipText>
      </a>
    </li>
  );
}
