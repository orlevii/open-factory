import type { ServerMessage } from "@open-factory/shared";
import type { notify } from "@/components/ui/toaster";

export type OrgActionFrame = Extract<ServerMessage, { type: "org_action" }>;

/** A burst of one actor's same action becomes one toast: the window opens at its first frame and is not extended. */
const WINDOW_MS = 2000;

const VERB = {
  agent_created: "created",
  agent_archived: "archived",
  agent_unarchived: "unarchived",
  template_created: "created",
} as const;

type Pending = { frame: OrgActionFrame; count: number; timer: ReturnType<typeof setTimeout> };

/**
 * Toasts for what agents did to the org (spec §8.3; the frame names the actor and an agent by ref). One toast per (actor, action) window: "@hr created @dev" for one
 * subject, "@hr created 3 agents" for several. `dispose` clears every pending window.
 */
export function createOrgToasts(d: {
  notify: typeof notify;
  navigate: (to: string) => void;
  /** The current handle of a ref a frame names, if the principals cache knows it. */
  handleOf: (ref: string) => string | undefined;
}) {
  const pending = new Map<string, Pending>();

  function show({ frame, count }: Pending) {
    const template = frame.action === "template_created";
    const verb = VERB[frame.action];
    const by = `@${d.handleOf(frame.by) ?? "an agent"}`;
    if (count === 1) {
      d.notify({
        text: template
          ? `${by} ${verb} template ${frame.subject}`
          : `${by} ${verb} @${d.handleOf(frame.subject) ?? "an agent"}`,
        action: {
          label: "Open",
          run: () =>
            d.navigate(template ? `/templates/${frame.subject}` : `/agents/${frame.subject}/chat`),
        },
      });
      return;
    }
    d.notify({
      text: `${by} ${verb} ${count} ${template ? "templates" : "agents"}`,
      action: { label: "Open", run: () => d.navigate(template ? "/templates" : "/agents") },
    });
  }

  return {
    onOrgAction(frame: OrgActionFrame) {
      const key = `${frame.by}\n${frame.action}`;
      const open = pending.get(key);
      if (open) {
        open.count += 1;
        return;
      }
      const entry: Pending = {
        frame,
        count: 1,
        timer: setTimeout(() => {
          pending.delete(key);
          show(entry);
        }, WINDOW_MS),
      };
      pending.set(key, entry);
    },
    dispose() {
      for (const p of pending.values()) clearTimeout(p.timer);
      pending.clear();
    },
  };
}
