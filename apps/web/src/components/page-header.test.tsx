import { render, screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { HeaderSlug, PageHeader } from "@/components/page-header";
import { SidebarProvider } from "@/components/ui/sidebar";
import { StatusBadge } from "@/features/session/status-badge";
import { fakeMatchMedia } from "@/test/fake-match-media";

beforeEach(() => {
  fakeMatchMedia.install(false);
});

const NAME = "a-40-character-template-name-xxxxxxxxxxxx";
const SLUG = "dev-001-0123456789abcdef";

function setup(titleFromData: boolean) {
  render(
    <SidebarProvider>
      <PageHeader
        title={NAME}
        titleFromData={titleFromData}
        meta={
          <>
            <StatusBadge status="errored" size="short" />
            <HeaderSlug value={SLUG} />
          </>
        }
        actions={<button type="button">Delete</button>}
      />
    </SidebarProvider>,
  );
  const h1 = screen.getByRole("heading", { level: 1 });
  return { h1, header: h1.closest("header") as HTMLElement };
}

test("a data title truncates to a floor; meta, badge, slug and actions follow the give-way order", () => {
  const { h1, header } = setup(true);
  expect(header).toHaveClass("@container");
  expect(h1).toHaveClass("min-w-16", "truncate");
  expect(h1).toHaveAttribute("title", NAME);
  const meta = screen.getByText(SLUG).parentElement as HTMLElement;
  expect(meta).toHaveClass("min-w-0");
  const badge = screen.getByText("Errored");
  expect(badge).toHaveClass("shrink-0", "whitespace-nowrap");
  const slug = screen.getByText(SLUG);
  expect(slug).toHaveAttribute("data-slot", "header-slug");
  expect(slug).toHaveAttribute("title", SLUG);
  expect(slug).toHaveClass("@max-[32rem]:hidden", "truncate", "min-w-0");
  const actions = screen.getByRole("button", { name: "Delete" }).parentElement as HTMLElement;
  expect(actions).toHaveClass("ml-auto", "shrink-0");
});

test("a static title never shrinks", () => {
  const { h1 } = setup(false);
  expect(h1).toHaveClass("shrink-0");
  expect(h1).not.toHaveClass("truncate");
});
