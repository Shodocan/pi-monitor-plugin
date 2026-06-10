/** Host-agnostic prompt scheduler. No Pi, bridge, HTTP, MCP, or status-store concepts. */

export type SchedulerKind = 'loop' | 'sched';

export type DeliveryCallback = (request: PromptSchedulerRequest) => void | Promise<void>;

/** Request shape delivered by the scheduler to the delivery layer. */
export interface PromptSchedulerRequest {
  sessionID: string;
  agent?: string;
  jobID: string;
  kind: SchedulerKind;
  text: string;
  submit: true;
}

/** Configuration for a looping prompt job. */
export interface LoopConfig {
  jobID: string;
  sessionID: string;
  agent?: string;
  intervalMs: number;
  prompt: string;
}

/** Configuration for a one-shot scheduled prompt. */
export interface ScheduleConfig {
  jobID: string;
  sessionID: string;
  agent?: string;
  runAt: Date;
  prompt: string;
}

export interface SchedulerOptions {
  delivery: DeliveryCallback;
}

/**
 * Manages loop and one-shot prompt scheduling.
 *
 * Loops: immediate first tick, then chain setTimeout after each delivery.
 *         Only one tick is active at a time — no backlog can accumulate.
 *         Delivery errors are swallowed; the loop survives and reschedules.
 *
 * One-shot: fires once at `runAt`, cleans up active state regardless of delivery outcome.
 */
export class PromptScheduler {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private active = new Set<string>();
  private delivery: DeliveryCallback;

  constructor(opts: SchedulerOptions) {
    this.delivery = opts.delivery;
  }

  /**
   * Start a looping scheduler that fires every `intervalMs`.
   * The first tick fires immediately. Each subsequent tick is chained after
   * delivery completes, so only one tick is active at a time (no backlog).
   * Delivery errors are swallowed; the loop survives and reschedules.
   */
  scheduleLoop(cfg: LoopConfig): void {
    if (this.active.has(cfg.jobID)) return;
    this.active.add(cfg.jobID);
    this.tickLoop(cfg);
  }

  /**
   * Schedule a one-shot at the given Date.
   * If `runAt` is in the past, fires immediately on next tick.
   */
  scheduleOnce(cfg: ScheduleConfig): void {
    if (this.active.has(cfg.jobID)) return;

    this.active.add(cfg.jobID);
    const delay = Math.max(0, cfg.runAt.getTime() - Date.now());
    const { jobID, agent, prompt, sessionID } = cfg;
    const kind: SchedulerKind = 'sched';

    const timer = setTimeout(() => {
      this.timers.delete(jobID);
      const cleanup = () => this.active.delete(jobID);
      try {
        const result = this.delivery({ sessionID, agent, jobID, kind, text: prompt, submit: true });
        if (result && typeof result.then === 'function') result.catch(() => {}).finally(cleanup);
        else cleanup();
      } catch {
        cleanup();
      }
    }, delay);

    this.timers.set(jobID, timer);
  }

  /**
   * Cancel an active loop or scheduled one-shot by jobID.
   * Clears any pending timer. If a tick just fired and is awaiting
   * delivery, the guard flag will drop the request on next access.
   */
  cancel(jobID: string): boolean {
    if (!this.active.has(jobID)) return false;
    this.active.delete(jobID);

    const timer = this.timers.get(jobID);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(jobID);
    }
    return true;
  }

  /** Cancel all scheduled timers and clear bookkeeping. */
  destroy(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.active.clear();
  }

  /** Return the set of currently tracked job IDs. */
  get activeJobs(): Set<string> {
    return new Set(this.active);
  }

  // ----------------------------------------------------------------
  // Internals
  // ----------------------------------------------------------------

  private tickLoop(cfg: LoopConfig): void {
    if (!this.active.has(cfg.jobID)) return;

    const request: PromptSchedulerRequest = {
      sessionID: cfg.sessionID,
      agent: cfg.agent,
      jobID: cfg.jobID,
      kind: 'loop',
      text: cfg.prompt,
      submit: true,
    };

    const scheduleNext = () => {
      if (!this.active.has(cfg.jobID)) return;
      const timer = setTimeout(() => this.tickLoop(cfg), cfg.intervalMs);
      this.timers.set(cfg.jobID, timer);
    };

    try {
      const result = this.delivery(request);
      if (result && typeof result.then === 'function') result.catch(() => {}).finally(scheduleNext);
      else scheduleNext();
    } catch {
      scheduleNext();
    }
  }
}
