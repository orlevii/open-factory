import { render, screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { HeaderName, PageHeader } from "@/components/page-header";
import { SidebarProvider } from "@/components/ui/sidebar";
import { StatusBadge } from "@/features/session/status-badge";
import { fakeMatchMedia } from "@/test/fake-match-media";

beforeEach(() => {
  fakeMatchMedia.install(false);
});

const NAME = "a-40-character-template-name-xxxxxxxxxxxx";
const META = "dev-001-0123456789abcdef";

function setup(titleFromData: boolean) {
  render(
    <SidebarProvider>
      <PageHeader
        title={NAME}
        titleFromData={titleFromData}
        meta={
          <>
            <StatusBadge status="errored" size="short" />
            <HeaderName value={META} />
          </>
        }
        actions={<button type="button">Delete</button>}
      />
    </SidebarProvider>,
  );
  const h1 = screen.getByRole("heading", { level: 1 });
  return { h1, header: h1.closest("header") as HTMLElement };
}

test("a data title truncates to a floor; meta, badge, handle and actions follow the give-way order", () => {
  const { h1 } = setup(true);
  expect(h1).toHaveAttribute("title", NAME);
  expect(screen.getByText("Errored")).toBeInTheDocument();
  expect(screen.getByText(META)).toHaveAttribute("title", META);
  expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
});

test("a static title never shrinks and has no title attribute", () => {
  const { h1 } = setup(false);
  expect(h1).not.toHaveAttribute("title");
});

test("a truncating custom heading keeps its full value in title", () => {
  render(
    <SidebarProvider>
      <PageHeader title={META} heading={<span className="font-mono">{META}</span>} />
    </SidebarProvider>,
  );
  const h1 = screen.getByRole("heading", { level: 1 });
  expect(h1).toHaveAttribute("title", META);
});
