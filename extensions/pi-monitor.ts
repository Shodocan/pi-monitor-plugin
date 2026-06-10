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
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { JobRegistry } from "../src/registry.ts";
import { ProcessRunner } from "../src/runner/process-runner.ts";
import { MonitorEngine } from "../src/runner/monitor-engine.ts";
import { vetRegexPattern, close as closeRedos } from "../src/runner/redos.ts";
import { parseBackground, parseMonitor } from "../src/parser/index.ts";
import { DeliveryService } from "../src/delivery.ts";
import type { OutputEvent } from "../src/types.ts";
import { MIN_MONITOR_DEBOUNCE_S, MAX_MONITOR_DEBOUNCE_S } from "../src/limits.ts";

/* ------------------------------------------------------------------ */
/* Tool schemas (TypeBox — no @earendil-works/pi-ai import yet)       */
/* ------------------------------------------------------------------ */

const BackgroundToolSchema = Type.Object({
  command: Type.String(),
});

const MonitorToolSchema = Type.Object({
  command: Type.String(),
  regex: Type.String(),
  before: Type.Optional(Type.Number()),
  after: Type.Optional(Type.Number()),
  debounceSeconds: Type.Optional(Type.Number()),
  deliver: Type.Optional(Type.String({ description: 'polite (default) or steer' })),
});

const MAX_MONITOR_CONTEXT_LINES = 200;

type BackgroundToolParams = Static<typeof BackgroundToolSchema>;
type MonitorToolParams = Static<typeof MonitorToolSchema>;

export default function (pi: ExtensionAPI) {
  /* Session-local runtime state (factory closure) */
  let registry: JobRegistry | null = null;
  let runner: ProcessRunner | null = null;
  let engines: Map<string, MonitorEngine> | null = null;
  let delivery: DeliveryService | null = null;

  pi.on("session_start", async (_event, ctx) => {
    registry = new JobRegistry(ctx.sessionManager.getSessionId());
    runner = new ProcessRunner();
    engines = new Map();
    delivery = new DeliveryService();
    ctx.ui.setStatus("pi-monitor", "jobs idle");
  });

  pi.on("session_shutdown", async () => {
    if (engines) {
      for (const engine of engines.values()) engine.destroy();
    }
    if (registry) {
      for (const job of registry.active()) {
        runner?.dispose(job.jobID);
      }
    }
    delivery?.clear();
    await closeRedos();
    registry = null;
    runner = null;
    engines = null;
    delivery = null;
  });

  /* ---------------------------------------------------------------- */
  /* Shared handlers                                                 */
  /* ---------------------------------------------------------------- */

  async function handleBackground(
    ctx: ExtensionContext,
    command: string,
  ): Promise<string> {
    const r = registry!;
    const runnerRef = runner!;
    const deliveryRef = delivery!;
    const jobID = r.register("bg");
    let exitPromise: Promise<number | null>;
    try {
      ({ exitPromise } = runnerRef.run(jobID, command));
    } catch (error) {
      r.fail(jobID);
      throw error;
    }

    (async () => {
      try {
        await exitPromise;
        r.complete(jobID);
        const tail = runnerRef.tail(jobID, "stdout")
          .concat(runnerRef.tail(jobID, "stderr"))
          .join("\n");
        if (tail.length > 0) {
          deliveryRef.deliver(pi, ctx, {
            jobID,
            kind: "bg",
            content: tail,
            urgency: "polite",
            isProcessOutput: true,
            isLoopTick: false,
          });
        }
      } catch {
        r.fail(jobID);
      }
    })().catch(() => {});

    return `started ${jobID}`;
  }

  async function handleMonitor(
    ctx: ExtensionContext,
    command: string,
    regex: RegExp,
    before: number,
    after: number,
    debounceMs: number,
    urgency: "polite" | "interrupt" = "polite",
  ): Promise<string> {
    const r = registry!;
    const runnerRef = runner!;
    const enginesRef = engines!;
    const deliveryRef = delivery!;
    await vetRegexPattern(regex.source, regex.flags);

    const jobID = r.register("mon");
    let engine: MonitorEngine | null = null;
    let onOutput: ((event: OutputEvent) => void) | null = null;
    let exitPromise: Promise<number | null>;
    try {
      engine = new MonitorEngine({
        jobID,
        regex,
        before,
        after,
        debounceMs,
        onWindow: (window) => {
          const lines = window.events.map((e) => e.line).join("\n");
          deliveryRef.deliver(pi, ctx, {
            jobID,
            kind: "mon",
            content: lines,
            urgency,
            isProcessOutput: true,
            isLoopTick: false,
          });
        },
      });
      ({ exitPromise } = runnerRef.run(jobID, command));
    } catch (error) {
      engine?.destroy();
      enginesRef.delete(jobID);
      runnerRef.dispose(jobID);
      r.fail(jobID);
      throw error;
    }

    enginesRef.set(jobID, engine);

    onOutput = (event: OutputEvent) => {
      engine.ingest(event);
    };
    runnerRef.on("output", onOutput);

    (async () => {
      try {
        await exitPromise;
        engine.flush();
        r.complete(jobID);
      } catch {
        r.fail(jobID);
      } finally {
        if (onOutput) runnerRef.removeListener("output", onOutput);
        engine.destroy();
        enginesRef.delete(jobID);
      }
    })().catch(() => {});

    return `started ${jobID}`;
  }

  /* ---------------------------------------------------------------- */
  /* Slash command handlers                                            */
  /* ---------------------------------------------------------------- */

  for (const name of ["loop", "schedule", "jobs", "cancel"]) {
    pi.registerCommand(name, {
      description: `${name} — pi-monitor (not implemented yet)`,
      handler: async (_args, ctx) => {
        ctx.ui.notify(
          `pi-monitor: /${name} is scaffolded but not implemented yet — see PLAN.md milestone M1`,
          "warning",
        );
      },
    });
  }

  pi.registerCommand("background", {
    description: "Run a shell command in the background; deliver the output tail on exit",
    handler: async (args, ctx) => {
      const { command } = parseBackground(args);
      const result = await handleBackground(ctx, command);
      ctx.ui.notify(result);
    },
  });

  pi.registerCommand("monitor", {
    description:
      "Watch a command's output for a regex; deliver matching windows (--regex ... -- cmd)",
    handler: async (args, ctx) => {
      const parsed = parseMonitor(args);
      const result = await handleMonitor(
        ctx,
        parsed.command,
        parsed.regex,
        parsed.before,
        parsed.after,
        parsed.debounceMs,
      );
      ctx.ui.notify(result);
    },
  });

  /* ---------------------------------------------------------------- */
  /* AI-callable tools                                                */
  /* ---------------------------------------------------------------- */

  pi.registerTool({
    name: "jobs_background",
    label: "jobs_background",
    description:
      "Run a shell command in the background. Returns immediately with the job ID; output is delivered on exit.",
    parameters: BackgroundToolSchema,
    execute: async (
      _toolCallId: string,
      params: BackgroundToolParams,
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      ctx: ExtensionContext,
    ) => {
      const result = await handleBackground(ctx, params.command);
      return { content: [{ type: "text", text: result }] as const, details: undefined };
    },
  });

  pi.registerTool({
    name: "jobs_monitor",
    label: "jobs_monitor",
    description:
      "Watch a command's output for a regex pattern. Returns immediately with the job ID; matching windows are delivered asynchronously.",
    parameters: MonitorToolSchema,
    execute: async (
      _toolCallId: string,
      params: MonitorToolParams,
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      ctx: ExtensionContext,
    ) => {
      const regex = new RegExp(params.regex);
      const before = params.before ?? 10;
      const after = params.after ?? 10;
      if (!Number.isInteger(before) || before < 0 || before > MAX_MONITOR_CONTEXT_LINES) {
        throw new Error(`jobs_monitor: before must be 0..${MAX_MONITOR_CONTEXT_LINES}`);
      }
      if (!Number.isInteger(after) || after < 0 || after > MAX_MONITOR_CONTEXT_LINES) {
        throw new Error(`jobs_monitor: after must be 0..${MAX_MONITOR_CONTEXT_LINES}`);
      }
      const debounceSeconds = params.debounceSeconds ?? 5;
      if (
        !Number.isInteger(debounceSeconds) ||
        debounceSeconds < MIN_MONITOR_DEBOUNCE_S ||
        debounceSeconds > MAX_MONITOR_DEBOUNCE_S
      ) {
        throw new Error(`jobs_monitor: debounceSeconds must be ${MIN_MONITOR_DEBOUNCE_S}..${MAX_MONITOR_DEBOUNCE_S}`);
      }
      const debounceMs = debounceSeconds * 1_000;
      const urgency = params.deliver === "steer" ? "interrupt" : "polite";
      const result = await handleMonitor(ctx, params.command, regex, before, after, debounceMs, urgency);
      return { content: [{ type: "text", text: result }] as const, details: undefined };
    },
  });
}
