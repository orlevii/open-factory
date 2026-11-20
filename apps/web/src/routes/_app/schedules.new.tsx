import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { PageBody, PageHeader } from "@/components/page-header";
import {
  type CreateScheduleBody,
  createSchedule,
  schedulesQueryKey,
} from "@/features/schedules/api";
import { BackLink } from "@/features/schedules/back-link";
import { ScheduleForm } from "@/features/schedules/schedule-form";

export const Route = createFileRoute("/_app/schedules/new")({
  validateSearch: z.object({ target: z.string().min(1).max(64).optional().catch(undefined) }),
  component: NewSchedule,
});

function NewSchedule() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { target } = Route.useSearch();
  return (
    <>
      <PageHeader title="New schedule" />
      <PageBody>
        <div className="grid gap-4">
          <BackLink />
          <ScheduleForm
            presetTarget={target}
            onSubmit={async (body) => {
              const s = await createSchedule(body as CreateScheduleBody);
              await qc.invalidateQueries({ queryKey: schedulesQueryKey });
              await navigate({
                to: "/schedules",
                search: {},
                state: { outcome: { text: `Created ${s.key}.` } } as never,
              });
            }}
          />
        </div>
      </PageBody>
    </>
  );
}
