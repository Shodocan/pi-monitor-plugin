/**
 * pi-monitor — background / monitor / loop / schedule jobs for pi.
 *
 * M1 implementation: all six commands + six tools, delivery coalescing, lifecycle cleanup.
 * PLAN.md §3.3 tool table and §3.2 delivery tree are the authoritative specs.
 */
import { Type, type Static } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { JobRegistry } from "../src/registry.ts";
import { ProcessRunner } from "../src/runner/process-runner.ts";
import { MonitorEngine } from "../src/runner/monitor-engine.ts";
import { vetRegexPattern, close as closeRedos } from "../src/runner/redos.ts";
import { PromptScheduler } from "../src/scheduler.ts";
import type { DeliveryCallback, LoopConfig, ScheduleConfig, PromptSchedulerRequest } from "../src/scheduler.ts";
import { parseBackground, parseMonitor, parseLoop, parseSchedule } from "../src/parser/index.ts";
import { DeliveryService } from "../src/delivery.ts";
import type { OutputEvent, JobRecord, ProcessExit } from "../src/types.ts";
import { formatJobStatus, formatJobWidget } from "../src/ui.ts";
import { formatJobs, formatCancel } from "../src/delivery-format.ts";
import {
  MIN_LOOP_INTERVAL_MS,
  MAX_SCHEDULE_HORIZON_MS,
  MIN_MONITOR_DEBOUNCE_S,
  MAX_MONITOR_DEBOUNCE_S,
  MAX_REGEX_PATTERN_LENGTH,
} from "../src/limits.ts";

const MAX_MONITOR_CONTEXT_LINES = 200;

/* ------------------------------------------------------------------ */
/* Tool schemas (TypeBox + StringEnum from @earendil-works/pi-ai)      */
/* ------------------------------------------------------------------ */

const BackgroundToolSchema = Type.Object({
  command: Type.String(),
});

const MonitorToolSchema = Type.Object({
  command: Type.String(),
  regex: Type.String(),
  regexFlags: Type.Optional(Type.String({ description: "RegExp flags (default: '')" })),
  before: Type.Optional(Type.Number()),
  after: Type.Optional(Type.Number()),
  debounceSeconds: Type.Optional(Type.Number()),
  deliver: Type.Optional(StringEnum(["polite", "steer"], {
    description: "Delivery urgency (default: polite)",
    default: "polite",
  })),
});

const LoopToolSchema = Type.Object({
  intervalSeconds: Type.Number(),
  prompt: Type.String(),
});

const ScheduleToolSchema = Type.Object({
  at: Type.Optional(Type.String({ description: "ISO-8601 date/time (mutually exclusive with inSeconds)" })),
  inSeconds: Type.Optional(Type.Number()),
  prompt: Type.String(),
});

const CancelToolSchema = Type.Object({
  jobID: Type.String(),
});

const ListToolSchema = Type.Object({});

type BackgroundToolParams = Static<typeof BackgroundToolSchema>;
type MonitorToolParams = Static<typeof MonitorToolSchema>;
type LoopToolParams = Static<typeof LoopToolSchema>;
type ScheduleToolParams = Static<typeof ScheduleToolSchema>;
type CancelToolParams = Static<typeof CancelToolSchema>;
type ListToolParams = Static<typeof ListToolSchema>;

/* ------------------------------------------------------------------ */
/* Extension factory                                                 */
/* ------------------------------------------------------------------ */

export default function (pi: ExtensionAPI) {
  /* Session-local runtime state (factory closure) */
  let registry: JobRegistry | null = null;
  let runner: ProcessRunner | null = null;
  let engines: Map<string, MonitorEngine> | null = null;
  let scheduler: PromptScheduler | null = null;
  let delivery: DeliveryService | null = null;
  let isShuttingDown = false;
  let activeCtx: ExtensionContext | null = null;

  /** Push current active-job summary to the TUI footer + widget. */
  function updateJobUi(ctx: ExtensionContext): void {
    if (!ctx.hasUI || !registry || isShuttingDown) return;
    const activeJobs = registry.active();
    ctx.ui.setStatus("pi-monitor", formatJobStatus(activeJobs));
    ctx.ui.setWidget("pi-monitor", formatJobWidget(activeJobs));
  }

  /** Best-effort UI cleanup (called during teardown). */
  function clearJobUi(): void {
    const ctx = activeCtx;
    if (!ctx?.hasUI) return;
    try {
      ctx.ui.setStatus("pi-monitor", undefined);
      ctx.ui.setWidget("pi-monitor", undefined);
    } catch {
      // Session may already be tearing down; UI cleanup is best-effort.
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    isShuttingDown = false;
    activeCtx = ctx;
    registry = new JobRegistry(ctx.sessionManager.getSessionId());
    runner = new ProcessRunner();
    engines = new Map();
    delivery = new DeliveryService();

    const deliveryCb: DeliveryCallback = (req: PromptSchedulerRequest): void | Promise<void> => {
      deliverPrompt(pi, ctx, req);
      return undefined;
    };
    scheduler = new PromptScheduler({ delivery: deliveryCb });
    updateJobUi(ctx);
  });

  pi.on("session_shutdown", async () => {
    // Guard against stale-session emissions before tearing anything down.
    isShuttingDown = true;
    clearJobUi();

    // 1. Cancel all active scheduler jobs (loops + one-shot)
    if (scheduler) {
      scheduler.destroy();
      scheduler = null;
    }

    // 2. Cancel active runner processes (SIGTERM → SIGKILL), then dispose
    if (registry && runner) {
      const activeRunnerJobs = registry.active().filter(
        (job) => job.kind === 'bg' || job.kind === 'mon',
      );
      for (const job of activeRunnerJobs) {
        try {
          registry.cancel(job.jobID);
        } catch {
          // Already completed/cancelled; shutdown continues.
        }
      }
      await Promise.allSettled(
        activeRunnerJobs.map((job) => runner!.cancel(job.jobID)),
      );
      for (const job of activeRunnerJobs) runner.dispose(job.jobID);
    }

    // 3. Destroy all monitor engines
    if (engines) {
      for (const engine of engines.values()) engine.destroy();
      engines.clear();
    }

    // 4. Clear delivery coalescing
    delivery?.clear();
    delivery = null;

    // 5. Close ReDoS workers
    await closeRedos();

    // 6. Drop stale refs
    engines = null;
    runner = null;
    registry = null;
    activeCtx = null;
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!registry || !delivery) return;
    for (const job of registry.active()) {
      if (job.kind === "loop") {
        delivery.flushCoalescedLoop(pi, ctx, job.jobID);
      }
    }
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
    const jobID = r.register("bg", { summary: command });
    let exitPromise: Promise<ProcessExit>;
    try {
      ({ exitPromise } = runnerRef.run(jobID, command));
    } catch (error) {
      r.fail(jobID);
      throw error;
    }

    updateJobUi(ctx);

    (async () => {
      try {
        await exitPromise;
        // Once shutdown begins the session owns teardown: it has already
        // cancelled/disposed this process and is tearing down delivery. Bail
        // out before reading tail or delivering so stale buffered output is
        // never pushed to a dying session (and we avoid a double dispose).
        if (isShuttingDown) return;
        r.complete(jobID);
        updateJobUi(ctx);
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
        if (!isShuttingDown) {
          r.fail(jobID);
          updateJobUi(ctx);
        }
      } finally {
        if (!isShuttingDown) {
          runnerRef.dispose(jobID);
        }
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

    const jobID = r.register("mon", { summary: `${regex.toString()} -- ${command}` });
    let engine: MonitorEngine | null = null;
    let onOutput: ((event: OutputEvent) => void) | null = null;
    let exitPromise: Promise<ProcessExit>;
    try {
      engine = new MonitorEngine({
        jobID,
        regex,
        before,
        after,
        debounceMs,
        onWindow: (window) => {
          if (isShuttingDown || r.get(jobID)?.state !== "active") return;
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

    updateJobUi(ctx);

    (async () => {
      try {
        await exitPromise;
        if (isShuttingDown) return;
        engine.flush();
        if (isShuttingDown) return;
        r.complete(jobID);
        updateJobUi(ctx);
      } catch {
        if (!isShuttingDown) {
          r.fail(jobID);
          updateJobUi(ctx);
        }
      } finally {
        // removeListener is always safe and avoids a leaked emitter binding;
        // the remaining cleanup side effects are already performed by
        // session_shutdown (which destroys engines, clears the map, and
        // disposes runner handles), so guard them to avoid double cleanup
        // and stale teardown against a dying session.
        if (onOutput) runnerRef.removeListener("output", onOutput);
        if (!isShuttingDown) {
          engine.destroy();
          enginesRef.delete(jobID);
          runnerRef.dispose(jobID);
        }
      }
    })().catch(() => {});

    return `started ${jobID}`;
  }

  async function handleLoop(
    ctx: ExtensionContext,
    intervalMs: number,
    prompt: string,
  ): Promise<string> {
    const r = registry!;
    const sched = scheduler!;
    const jobID = r.register("loop", { summary: `every ${Math.floor(intervalMs / 1_000)}s: ${prompt}` });

    const cfg: LoopConfig = {
      jobID,
      sessionID: r.sessionID,
      intervalMs,
      prompt,
    };

    // Override the scheduler's delivery callback for this loop to include coalescing
    sched.scheduleLoop(cfg);
    updateJobUi(ctx);
    return `started ${jobID}`;
  }

  async function handleSchedule(
    ctx: ExtensionContext,
    runAt: Date,
    prompt: string,
  ): Promise<string> {
    const r = registry!;
    const sched = scheduler!;
    const jobID = r.register("sched", { summary: `at ${runAt.toISOString()}: ${prompt}` });

    const cfg: ScheduleConfig = {
      jobID,
      sessionID: r.sessionID,
      runAt,
      prompt,
    };

    sched.scheduleOnce(cfg);
    updateJobUi(ctx);
    return `started ${jobID}`;
  }

  function validatePrompt(source: string, prompt: string): string {
    const trimmed = prompt.trim();
    if (trimmed.length === 0) {
      throw new Error(`${source}: prompt is empty`);
    }
    return trimmed;
  }

  function validateToolLoop(params: LoopToolParams): { intervalMs: number; prompt: string } {
    if (!Number.isFinite(params.intervalSeconds) || !Number.isInteger(params.intervalSeconds)) {
      throw new Error("jobs_loop: intervalSeconds must be an integer number of seconds");
    }
    const intervalMs = params.intervalSeconds * 1_000;
    if (intervalMs < MIN_LOOP_INTERVAL_MS) {
      throw new Error(`jobs_loop: intervalSeconds must be >= ${MIN_LOOP_INTERVAL_MS / 1_000}`);
    }
    return { intervalMs, prompt: validatePrompt("jobs_loop", params.prompt) };
  }

  function validateToolSchedule(params: ScheduleToolParams): { runAt: Date; prompt: string } {
    const hasAt = params.at !== undefined;
    const hasInSeconds = params.inSeconds !== undefined;
    if (hasAt === hasInSeconds) {
      throw new Error("jobs_schedule: provide exactly one of 'at' (ISO date) or 'inSeconds'");
    }

    const now = Date.now();
    let runAt: Date;
    if (hasAt) {
      runAt = new Date(params.at!);
      if (Number.isNaN(runAt.getTime())) {
        throw new Error("jobs_schedule: 'at' must be a valid ISO-8601 date");
      }
      if (runAt.getTime() <= now) {
        throw new Error("jobs_schedule: 'at' target must be in the future");
      }
    } else {
      if (!Number.isFinite(params.inSeconds!) || !Number.isInteger(params.inSeconds!) || params.inSeconds! <= 0) {
        throw new Error("jobs_schedule: 'inSeconds' must be a positive integer number of seconds");
      }
      runAt = new Date(now + params.inSeconds! * 1_000);
    }

    if (runAt.getTime() > now + MAX_SCHEDULE_HORIZON_MS) {
      throw new Error("jobs_schedule: target exceeds 30-day horizon");
    }
    return { runAt, prompt: validatePrompt("jobs_schedule", params.prompt) };
  }

  function handleList(ctx: ExtensionContext): string {
    const r = registry!;
    const jobs: Array<{ jobID: string; kind: string; status: string }> = [];
    for (const job of r.list()) {
      jobs.push({
        jobID: job.jobID,
        kind: job.kind as import("../src/types.ts").JobKind,
        status: job.state,
      });
    }
    if (jobs.length === 0) {
      return "no jobs";
    }
    const formatted = formatJobs(jobs as import("../src/delivery-format.ts").JobStatus[]);
    return formatted.text;
  }

  async function handleCancel(ctx: ExtensionContext, jobID: string): Promise<string> {
    const r = registry!;
    const runnerRef = runner!;
    const schedRef = scheduler;
    const enginesRef = engines!;

    const record = r.get(jobID);
    if (!record) {
      return `job ${jobID} not found`;
    }
    if (record.state !== "active") {
      return `job ${jobID} cannot be cancelled (state: ${record.state})`;
    }

    // Cancel scheduler resource (loop or one-shot)
    if (schedRef) {
      schedRef.cancel(jobID);
    }

    // Destroy monitor engine
    const engine = enginesRef.get(jobID);
    if (engine) {
      engine.destroy();
      enginesRef.delete(jobID);
    }

    // Mark registry cancelled before awaiting process teardown so async process
    // completion cannot race the registry into a false completed/failed state.
    try {
      r.cancel(jobID);
      updateJobUi(ctx);
    } catch (error) {
      const latest = r.get(jobID);
      if (latest && latest.state !== "active") {
        return `job ${jobID} cannot be cancelled (state: ${latest.state})`;
      }
      throw error;
    }

    // Cancel runner process (SIGTERM → SIGKILL)
    if (runnerRef) {
      try {
        await runnerRef.cancel(jobID);
      } catch {
        // Process may already be gone
      }
    }

    return `${jobID} → cancelled`;
  }

  /* ---------------------------------------------------------------- */
  /* Prompt delivery from scheduler                                 */
  /* ---------------------------------------------------------------- */

  function deliverPrompt(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    req: PromptSchedulerRequest,
  ): void {
    const registryRef = registry;
    if (!registryRef) return;
    const deliveryRef = delivery!;
    try {
      deliveryRef.deliver(pi, ctx, {
        jobID: req.jobID,
        kind: req.kind === "loop" ? "loop" : "sched",
        content: req.text,
        urgency: "polite",
        isProcessOutput: false,
        isLoopTick: req.kind === "loop",
      });
      if (req.kind === "sched") {
        registryRef.complete(req.jobID);
        updateJobUi(ctx);
      }
    } catch (error) {
      if (req.kind === "sched") {
        registryRef.fail(req.jobID);
        updateJobUi(ctx);
      }
      throw error;
    }
  }
  /* ---------------------------------------------------------------- */
  /* Slash command handlers                                            */
  /* ---------------------------------------------------------------- */

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

  pi.registerCommand("loop", {
    description: "Repeat a prompt on an interval; busy ticks coalesce (/loop 5m <prompt>)",
    handler: async (args, ctx) => {
      const { intervalMs, prompt } = parseLoop(args);
      const result = await handleLoop(ctx, intervalMs, prompt);
      ctx.ui.notify(result);
    },
  });

  pi.registerCommand("schedule", {
    description: "Submit a prompt once, later (/schedule in 10m <prompt> | at <iso> <prompt>)",
    handler: async (args, ctx) => {
      const { runAt, prompt } = parseSchedule(args);
      const result = await handleSchedule(ctx, runAt, prompt);
      ctx.ui.notify(result);
    },
  });

  pi.registerCommand("jobs", {
    description: "List active and recent background jobs",
    handler: async (_args, ctx) => {
      const result = handleList(ctx);
      ctx.ui.notify(result);
    },
  });

  pi.registerCommand("cancel", {
    description: "Cancel a job by ID (/cancel <jobID>)",
    handler: async (args, ctx) => {
      const jobID = args.trim();
      if (!jobID) {
        ctx.ui.notify("Usage: /cancel <jobID>", "warning");
        return;
      }
      const result = await handleCancel(ctx, jobID);
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
      // Validate regex pattern length (parity with parseMonitor)
      if (params.regex.length > MAX_REGEX_PATTERN_LENGTH) {
        throw new Error(`jobs_monitor: regex pattern exceeds ${MAX_REGEX_PATTERN_LENGTH} characters`);
      }

      // Validate regex flags (parity with parseMonitor checkFlags)
      const flags = params.regexFlags ?? '';
      for (const ch of flags) {
        if (ch === 'g') throw new Error("jobs_monitor: unsupported regex flag 'g'");
        if (ch === 'y') throw new Error("jobs_monitor: unsupported regex flag 'y'");
      }

      const regex = new RegExp(params.regex, flags);
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

  pi.registerTool({
    name: "jobs_loop",
    label: "jobs_loop",
    description:
      "Repeatedly submit a prompt at a given interval. Returns immediately with the job ID; ticks coalesce while the session is busy.",
    parameters: LoopToolSchema,
    execute: async (
      _toolCallId: string,
      params: LoopToolParams,
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      ctx: ExtensionContext,
    ) => {
      const { intervalMs, prompt } = validateToolLoop(params);
      const result = await handleLoop(ctx, intervalMs, prompt);
      return { content: [{ type: "text", text: result }] as const, details: undefined };
    },
  });

  pi.registerTool({
    name: "jobs_schedule",
    label: "jobs_schedule",
    description:
      "Submit a prompt once at a future time. Returns immediately with the job ID.",
    parameters: ScheduleToolSchema,
    execute: async (
      _toolCallId: string,
      params: ScheduleToolParams,
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      ctx: ExtensionContext,
    ) => {
      const { runAt, prompt } = validateToolSchedule(params);
      const result = await handleSchedule(ctx, runAt, prompt);
      return { content: [{ type: "text", text: result }] as const, details: undefined };
    },
  });

  pi.registerTool({
    name: "jobs_list",
    label: "jobs_list",
    description: "List active and recently completed background jobs.",
    parameters: ListToolSchema,
    execute: async (
      _toolCallId: string,
      _params: ListToolParams,
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      ctx: ExtensionContext,
    ) => {
      const result = handleList(ctx);
      return { content: [{ type: "text", text: result }] as const, details: undefined };
    },
  });

  pi.registerTool({
    name: "jobs_cancel",
    label: "jobs_cancel",
    description: "Cancel a background job by ID.",
    parameters: CancelToolSchema,
    execute: async (
      _toolCallId: string,
      params: CancelToolParams,
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      ctx: ExtensionContext,
    ) => {
      const result = await handleCancel(ctx, params.jobID);
      return { content: [{ type: "text", text: result }] as const, details: undefined };
    },
  });
}
