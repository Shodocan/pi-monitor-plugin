/**
 * pi-monitor — background / monitor / loop / schedule jobs for pi.
 *
 * SCAFFOLD: command surface is registered, handlers are stubs. The implementation
 * plan, locked-in design decisions, and milestones live in ../PLAN.md (read it first);
 * API research with citations lives in ../docs/research/.
 *
 * Planned surface (PLAN.md §3.3):
 *   /background <command>
 *   /monitor --regex <pattern> [--before N] [--after N] [--debounce S] -- <command>
 *   /loop <interval> <prompt>
 *   /schedule in <duration> <prompt> | at <iso-date> <prompt>
 *   /jobs
 *   /cancel <jobID>
 * plus AI-callable tools jobs_background / jobs_monitor / jobs_loop / jobs_schedule /
 * jobs_list / jobs_cancel (TypeBox params), registered in M1 once handlers exist —
 * stubs are deliberately NOT registered as tools so a scaffold install does not
 * pollute the model's tool list with broken entries.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const COMMANDS: Record<string, string> = {
  background: "Run a shell command in the background; deliver the output tail on exit",
  monitor: "Watch a command's output for a regex; deliver matching windows (--regex ... -- cmd)",
  loop: "Repeat a prompt on an interval; busy ticks coalesce (/loop 5m <prompt>)",
  schedule: "Submit a prompt once, later (/schedule in 10m <prompt> | at <iso> <prompt>)",
  jobs: "List active and recent background jobs",
  cancel: "Cancel a job by ID (/cancel mon_1)",
};

export default function (pi: ExtensionAPI) {
  // M1 (PLAN.md §3.1): job registry, runner, scheduler, and delivery state are created
  // here per session_start and torn down in session_shutdown — never at module top level
  // (the factory re-runs on /reload, /new, /resume, /fork and old handles go stale).

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("pi-monitor", "jobs idle");
  });

  pi.on("session_shutdown", async () => {
    // M1: cancel all live jobs (SIGTERM group → 5s → SIGKILL), clear timers/watchers.
  });

  for (const [name, description] of Object.entries(COMMANDS)) {
    pi.registerCommand(name, {
      description: `${description} — pi-monitor (not implemented yet)`,
      handler: async (_args, ctx) => {
        ctx.ui.notify(
          `pi-monitor: /${name} is scaffolded but not implemented yet — see PLAN.md milestone M1`,
          "warning",
        );
      },
    });
  }
}
