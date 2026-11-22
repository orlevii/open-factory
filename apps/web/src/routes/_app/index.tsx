import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { PageBody, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { HomeAgents } from "@/features/agents/home-agents";
import { HomeInbox } from "@/features/inbox/home-inbox";

export const Route = createFileRoute("/_app/")({
  component: Dashboard,
});

function Dashboard() {
  return (
    <>
      <PageHeader title="Home" />
      <PageBody>
        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 md:grid-cols-2">
          <Panel id="panel-inbox" title="Inbox" to="/inbox" linkLabel="Open inbox">
            <HomeInbox />
          </Panel>
          <Panel id="panel-agents" title="Agents" to="/agents" linkLabel="Open agents">
            <HomeAgents />
          </Panel>
        </div>
      </PageBody>
    </>
  );
}

function Panel(props: {
  id: string;
  title: string;
  to: "/inbox" | "/agents";
  linkLabel: string;
  children: ReactNode;
}) {
  const headingId = `${props.id}-title`;
  return (
    <section aria-labelledby={headingId} className="rounded-lg border bg-card">
      <div className="flex h-10 items-center justify-between border-b px-4">
        <h2 id={headingId} className="text-[0.8125rem] font-medium">
          {props.title}
        </h2>
        <Button variant="ghost" size="icon-sm" className="-mr-2" asChild>
          <Link to={props.to} aria-label={props.linkLabel}>
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
      </div>
      <div className="p-4">{props.children}</div>
    </section>
  );
}
