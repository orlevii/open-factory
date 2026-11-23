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
  expect(h1).toHaveClass("min-w-16", "truncate", "@max-[22rem]:min-w-6");
  expect(h1).toHaveAttribute("title", NAME);
  // The meta wrapper adds no box: a box would collapse to 0px around the badge when the title
  // truncates, and the actions would paint over the badge. Its children are the header's own items.
  const meta = screen.getByText(SLUG).parentElement as HTMLElement;
  expect(meta).toHaveClass("contents");
  expect(meta).not.toHaveClass("shrink-[3]");
  const badge = screen.getByText("Errored");
  expect(badge).toHaveClass("shrink-0", "whitespace-nowrap");
  const slug = screen.getByText(SLUG);
  expect(slug).toHaveAttribute("data-slot", "header-slug");
  expect(slug).toHaveAttribute("title", SLUG);
  expect(slug).toHaveClass("@max-[32rem]:hidden", "truncate", "min-w-0");
  // Strictly slug-first: a zero basis means the slug only gets the room left after the title and
  // badge (up to its own width), so it is gone before the title loses a character.
  expect(slug).toHaveClass("basis-0", "grow", "max-w-max");
  const actions = screen.getByRole("button", { name: "Delete" }).parentElement as HTMLElement;
  expect(actions).toHaveClass("ml-auto", "shrink-0");
});

test("a static title never shrinks", () => {
  const { h1 } = setup(false);
  expect(h1).toHaveClass("shrink-0");
  expect(h1).not.toHaveClass("truncate");
});

test("a truncating custom heading keeps its full value in title", () => {
  render(
    <SidebarProvider>
      <PageHeader title={SLUG} heading={<span className="font-mono">{SLUG}</span>} />
    </SidebarProvider>,
  );
  const h1 = screen.getByRole("heading", { level: 1 });
  expect(h1).toHaveClass("min-w-0", "truncate");
  expect(h1).toHaveAttribute("title", SLUG);
});

test("a static title has no title attribute", () => {
  const { h1 } = setup(false);
  expect(h1).not.toHaveAttribute("title");
});
