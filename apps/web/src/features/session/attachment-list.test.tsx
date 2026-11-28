import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { AttachmentList } from "./attachment-list";

test("a file chip is a download link named with its size, never a preview", () => {
  render(
    <AttachmentList
      agentRef="r1"
      attachments={[{ uploadId: "u1", name: "report.zip", kind: "file", bytes: 1_258_291 }]}
    />,
  );
  const link = screen.getByRole("link", { name: /^Download report\.zip\s+1\.2\sMB$/ });
  expect(link).toHaveAttribute("download");
  expect(link).not.toHaveAttribute("target");
  expect(link).toHaveAttribute("href", "/api/agents/r1/uploads/u1");
  expect(link.querySelector("img")).toBeNull();
});

test("a text chip downloads too", () => {
  render(
    <AttachmentList
      agentRef="r1"
      attachments={[{ uploadId: "u2", name: "run.log", kind: "text", bytes: 2048 }]}
    />,
  );
  const link = screen.getByRole("link", { name: /^Download run\.log\s+2\sKB$/ });
  expect(link).toHaveAttribute("download");
  expect(link).not.toHaveAttribute("target");
  expect(link.querySelector("[data-kind-icon]")).toHaveAttribute("data-kind-icon", "text");
});

test("an image chip opens in a new tab and previews up to 1 MB, with its size", () => {
  render(
    <AttachmentList
      agentRef="r1"
      attachments={[{ uploadId: "u3", name: "shot.png", kind: "image", bytes: 500_000 }]}
    />,
  );
  const link = screen.getByRole("link", { name: /^Open shot\.png\s+488\sKB$/ });
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  const imgs = link.querySelectorAll("img");
  expect(imgs).toHaveLength(1);
  expect(imgs[0]).toHaveAttribute("src", "/api/agents/r1/uploads/u3");
});

test("an image over 1 MB shows its size and previews only when asked", async () => {
  render(
    <AttachmentList
      agentRef="r1"
      attachments={[{ uploadId: "u4", name: "big.png", kind: "image", bytes: 5_000_000 }]}
    />,
  );
  const link = screen.getByRole("link", { name: /^Open big\.png\s+4\.8\sMB$/ });
  expect(link.querySelector("img")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Show preview of big.png" }));
  expect(link.querySelectorAll("img")).toHaveLength(1);
  expect(screen.getByRole("link", { name: /^Open big\.png\s+4\.8\sMB$/ })).toBe(link);
});

test("an RTL name and the size are separate text runs", () => {
  render(
    <AttachmentList
      agentRef="r1"
      attachments={[{ uploadId: "u5", name: "קובץ.zip", kind: "file", bytes: 1024 }]}
    />,
  );
  const link = screen.getByRole("link");
  const size = link.querySelector("[data-size]");
  expect(size).toHaveAttribute("dir", "ltr");
  expect(size).toHaveTextContent(/^1\sKB$/);
  expect(link.querySelector('[dir="auto"]')).toHaveTextContent("קובץ.zip");
});
