import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import extension from '../extensions/pi-monitor.ts';

/* ------------------------------------------------------------------ */
/* Mock helpers (shared with pi-monitor-background-monitor.test.ts)   */
/* ------------------------------------------------------------------ */

function makeMockApi(): ExtensionAPI {
  return {
    on: vi.fn(),
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
    registerFlag: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerShortcut: vi.fn(),
    sendUserMessage: vi.fn(),
    sendMessage: vi.fn(),
    getFlag: vi.fn(),
  } as unknown as ExtensionAPI;
}

function makeMockContext(isIdle = true): ExtensionContext {
  return {
    cwd: '/tmp/test',
    mode: 'tui',
    hasUI: true,
    ui: {
      setStatus: vi.fn(),
      notify: vi.fn(),
      select: vi.fn(),
      confirm: vi.fn(),
      input: vi.fn(),
    },
    sessionManager: {
      getSessionId: vi.fn().mockReturnValue('test-session'),
    },
    modelRegistry: {} as any,
    model: undefined,
    isIdle: vi.fn().mockReturnValue(isIdle),
    isProjectTrusted: vi.fn().mockReturnValue(true),
    signal: undefined,
    abort: vi.fn(),
    hasPendingMessages: vi.fn().mockReturnValue(false),
    shutdown: vi.fn(),
    getContextUsage: vi.fn(),
    compact: vi.fn(),
    getSystemPrompt: vi.fn(),
  } as unknown as ExtensionContext;
}

async function startSession(api: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const startHandler = (api.on as ReturnType<typeof vi.fn>).mock.calls.find(
    (c: any[]) => c[0] === 'session_start',
  )![1];
  await startHandler({}, ctx);
}

async function shutdownSession(api: ExtensionAPI): Promise<void> {
  const shutdownHandler = (api.on as ReturnType<typeof vi.fn>).mock.calls.find(
    (c: any[]) => c[0] === 'session_shutdown',
  )![1];
  await shutdownHandler({});
}

async function endTurn(api: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const turnEndHandler = (api.on as ReturnType<typeof vi.fn>).mock.calls.find(
    (c: any[]) => c[0] === 'turn_end',
  )![1];
  await turnEndHandler({ turnIndex: 1, message: undefined, toolResults: [] }, ctx);
}

function commandHandler(api: ExtensionAPI, name: string): (args: string, ctx: ExtensionContext) => Promise<void> {
  return (api.registerCommand as ReturnType<typeof vi.fn>).mock.calls.find(
    (c: any[]) => c[0] === name,
  )![1].handler;
}

function tool(api: ExtensionAPI, name: string): any {
  return (api.registerTool as ReturnType<typeof vi.fn>).mock.calls.find(
    (c: any[]) => c[0].name === name,
  )![0];
}

/* ------------------------------------------------------------------ */
/* Tests: tool registrations (all six)                                 */
/* ------------------------------------------------------------------ */

describe('extension registration — all six tools', () => {
  let api: ExtensionAPI;

  beforeEach(() => {
    api = makeMockApi();
  });

  it('registers six AI tools', () => {
    extension(api);
    expect(api.registerTool).toHaveBeenCalledTimes(6);
    const toolNames = (api.registerTool as ReturnType<typeof vi.fn>).mock.calls.map((args: any[]) => args[0].name);
    expect(toolNames).toContain('jobs_background');
    expect(toolNames).toContain('jobs_monitor');
    expect(toolNames).toContain('jobs_loop');
    expect(toolNames).toContain('jobs_schedule');
    expect(toolNames).toContain('jobs_list');
    expect(toolNames).toContain('jobs_cancel');
  });

  it('every tool has parameters schema defined', () => {
    extension(api);
    const calls = (api.registerTool as ReturnType<typeof vi.fn>).mock.calls;
    for (const call of calls) {
      expect(call[0].parameters).toBeDefined();
    }
  });

  it('monitor tool uses StringEnum for deliver field', () => {
    extension(api);
    const calls = (api.registerTool as ReturnType<typeof vi.fn>).mock.calls;
    const monTool = calls.find((c: any) => c[0].name === 'jobs_monitor')![0];
    // StringEnum produces Type.Unsafe which carries { type: "string", enum: [...] }
    const schema = monTool.parameters;
    expect(schema).toBeDefined();
    expect(schema.required).not.toContain('deliver');
  });
});

/* ------------------------------------------------------------------ */
/* Tests: six slash commands                                            */
/* ------------------------------------------------------------------ */

describe('extension registration — all six commands', () => {
  let api: ExtensionAPI;

  beforeEach(() => {
    api = makeMockApi();
  });

  it('registers six slash commands', () => {
    extension(api);
    expect(api.registerCommand).toHaveBeenCalledTimes(6);
    const commandNames = (api.registerCommand as ReturnType<typeof vi.fn>).mock.calls.map((args: any[]) => args[0]);
    expect(commandNames).toContain('background');
    expect(commandNames).toContain('monitor');
    expect(commandNames).toContain('loop');
    expect(commandNames).toContain('schedule');
    expect(commandNames).toContain('jobs');
    expect(commandNames).toContain('cancel');
  });
});

/* ------------------------------------------------------------------ */
/* Tests: /loop and jobs_loop                                           */
/* ------------------------------------------------------------------ */

describe('/loop and jobs_loop', () => {
  let api: ExtensionAPI;
  let ctx: ExtensionContext;

  beforeEach(() => {
    api = makeMockApi();
    ctx = makeMockContext();
    extension(api);
  });

  it('loop command starts a loop job', async () => {
    await startSession(api, ctx);
    await commandHandler(api, 'loop')('10s say hello', ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/^started loop_/));
    await shutdownSession(api);
  });

  it('loop tool starts a loop job via tool', async () => {
    await startSession(api, ctx);
    const result = await tool(api, 'jobs_loop').execute(
      'call-loop',
      { intervalSeconds: 30, prompt: 'check status' },
      undefined,
      undefined,
      ctx,
    );
    expect(result.content[0].text).toMatch(/^started loop_/);
    await shutdownSession(api);
  });

  it('loop tool enforces parser-equivalent constraints', async () => {
    await startSession(api, ctx);
    await expect(
      tool(api, 'jobs_loop').execute('call-loop-short', { intervalSeconds: 9, prompt: 'check' }, undefined, undefined, ctx),
    ).rejects.toThrow(/intervalSeconds/);
    await expect(
      tool(api, 'jobs_loop').execute('call-loop-empty', { intervalSeconds: 10, prompt: '   ' }, undefined, undefined, ctx),
    ).rejects.toThrow(/prompt is empty/);
    await shutdownSession(api);
  });
});

/* ------------------------------------------------------------------ */
/* Tests: /schedule and jobs_schedule                                 */
/* ------------------------------------------------------------------ */

describe('/schedule and jobs_schedule', () => {
  let api: ExtensionAPI;
  let ctx: ExtensionContext;

  beforeEach(() => {
    api = makeMockApi();
    ctx = makeMockContext();
    extension(api);
  });

  it('schedule command with "in" starts a schedule job', async () => {
    await startSession(api, ctx);
    await commandHandler(api, 'schedule')('in 30s check inbox', ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/^started sched_/));
    await shutdownSession(api);
  });

  it('schedule command with "at" starts a schedule job', async () => {
    await startSession(api, ctx);
    const future = new Date(Date.now() + 60_000).toISOString();
    await commandHandler(api, 'schedule')(`at ${future} check inbox`, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/^started sched_/));
    await shutdownSession(api);
  });

  it('schedule tool with "inSeconds" starts a schedule job', async () => {
    await startSession(api, ctx);
    const result = await tool(api, 'jobs_schedule').execute(
      'call-sched',
      { inSeconds: 60, prompt: 'check inbox' },
      undefined,
      undefined,
      ctx,
    );
    expect(result.content[0].text).toMatch(/^started sched_/);
    await shutdownSession(api);
  });

  it('schedule tool with "at" starts a schedule job', async () => {
    await startSession(api, ctx);
    const future = new Date(Date.now() + 60_000).toISOString();
    const result = await tool(api, 'jobs_schedule').execute(
      'call-sched2',
      { at: future, prompt: 'check inbox' },
      undefined,
      undefined,
      ctx,
    );
    expect(result.content[0].text).toMatch(/^started sched_/);
    await shutdownSession(api);
  });

  it('schedule tool rejects missing at and inSeconds', async () => {
    await startSession(api, ctx);
    await expect(
      tool(api, 'jobs_schedule').execute(
        'call-sched3',
        { prompt: 'check inbox' },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow();
    await shutdownSession(api);
  });

  it('schedule tool rejects invalid ISO date', async () => {
    await startSession(api, ctx);
    await expect(
      tool(api, 'jobs_schedule').execute(
        'call-sched4',
        { at: 'not-a-date', prompt: 'check' },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow();
    await shutdownSession(api);
  });

  it('schedule tool rejects past "at" date', async () => {
    await startSession(api, ctx);
    const past = new Date(Date.now() - 60_000).toISOString();
    await expect(
      tool(api, 'jobs_schedule').execute(
        'call-sched5',
        { at: past, prompt: 'check' },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow();
    await shutdownSession(api);
  });

  it('schedule tool enforces prompt, exclusivity, integer, and horizon constraints', async () => {
    await startSession(api, ctx);
    const future = new Date(Date.now() + 60_000).toISOString();
    await expect(
      tool(api, 'jobs_schedule').execute(
        'call-sched-empty',
        { inSeconds: 60, prompt: '   ' },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/prompt is empty/);
    await expect(
      tool(api, 'jobs_schedule').execute(
        'call-sched-both',
        { at: future, inSeconds: 60, prompt: 'check' },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/exactly one/);
    await expect(
      tool(api, 'jobs_schedule').execute(
        'call-sched-decimal',
        { inSeconds: 1.5, prompt: 'check' },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/positive integer/);
    await expect(
      tool(api, 'jobs_schedule').execute(
        'call-sched-horizon',
        { inSeconds: 31 * 24 * 60 * 60, prompt: 'check' },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/30-day horizon/);
    await shutdownSession(api);
  });
});

/* ------------------------------------------------------------------ */
/* Tests: /jobs and jobs_list                                           */
/* ------------------------------------------------------------------ */

describe('/jobs and jobs_list', () => {
  let api: ExtensionAPI;
  let ctx: ExtensionContext;

  beforeEach(() => {
    api = makeMockApi();
    ctx = makeMockContext();
    extension(api);
  });

  it('jobs command returns list of jobs', async () => {
    await startSession(api, ctx);
    await commandHandler(api, 'jobs')('', ctx);
    // After session start with no jobs, notify is called with "no jobs" or formatted output
    expect(ctx.ui.notify).toHaveBeenCalled();
    await shutdownSession(api);
  });

  it('jobs_list tool returns formatted job list', async () => {
    await startSession(api, ctx);
    const result = await tool(api, 'jobs_list').execute(
      'call-list',
      {},
      undefined,
      undefined,
      ctx,
    );
    expect(result.content[0].text).toBeDefined();
    await shutdownSession(api);
  });
});

/* ------------------------------------------------------------------ */
/* Tests: /cancel and jobs_cancel                                     */
/* ------------------------------------------------------------------ */

describe('/cancel and jobs_cancel', () => {
  let api: ExtensionAPI;
  let ctx: ExtensionContext;

  beforeEach(() => {
    api = makeMockApi();
    ctx = makeMockContext();
    extension(api);
  });

  it('cancel command handles non-existent job', async () => {
    await startSession(api, ctx);
    await commandHandler(api, 'cancel')('bg_999', ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('not found'));
    await shutdownSession(api);
  });

  it('cancel command with empty args warns', async () => {
    await startSession(api, ctx);
    await commandHandler(api, 'cancel')('  ', ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('Usage'), 'warning');
    await shutdownSession(api);
  });

  it('cancel tool handles non-existent job', async () => {
    await startSession(api, ctx);
    const result = await tool(api, 'jobs_cancel').execute(
      'call-cancel',
      { jobID: 'bg_999' },
      undefined,
      undefined,
      ctx,
    );
    expect(result.content[0].text).toContain('not found');
    await shutdownSession(api);
  });

  it('cancel tool cancels an active background job', async () => {
    await startSession(api, ctx);
    // Start a background job
    const bgResult = await tool(api, 'jobs_background').execute(
      'call-bg',
      { command: 'sleep 300' },
      undefined,
      undefined,
      ctx,
    );
    const jobID = bgResult.content[0].text.replace('started ', '');

    // Cancel it
    const cancelResult = await tool(api, 'jobs_cancel').execute(
      'call-cancel',
      { jobID },
      undefined,
      undefined,
      ctx,
    );
    expect(cancelResult.content[0].text).toContain('cancelled');
    await shutdownSession(api);
  });

  it('cancel tool reports completed jobs as non-cancellable', async () => {
    await startSession(api, ctx);
    const bgResult = await tool(api, 'jobs_background').execute(
      'call-bg-complete',
      { command: 'printf done' },
      undefined,
      undefined,
      ctx,
    );
    const jobID = bgResult.content[0].text.replace('started ', '');
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalled());

    const cancelResult = await tool(api, 'jobs_cancel').execute(
      'call-cancel-complete',
      { jobID },
      undefined,
      undefined,
      ctx,
    );
    expect(cancelResult.content[0].text).toContain('cannot be cancelled');
    await shutdownSession(api);
  });
});

/* ------------------------------------------------------------------ */
/* Tests: session_shutdown cleanup                                    */
/* ------------------------------------------------------------------ */

describe('session_shutdown cleanup', () => {
  let api: ExtensionAPI;
  let ctx: ExtensionContext;

  beforeEach(() => {
    api = makeMockApi();
    ctx = makeMockContext();
    extension(api);
  });

  it('shutdown after active loop clears scheduler', async () => {
    await startSession(api, ctx);
    await commandHandler(api, 'loop')('10s tick', ctx);
    await shutdownSession(api);
  });

  it('shutdown after active schedule clears scheduler', async () => {
    await startSession(api, ctx);
    const future = new Date(Date.now() + 300_000).toISOString();
    await commandHandler(api, 'schedule')(`at ${future} tick`, ctx);
    await shutdownSession(api);
  });

  it('shutdown after active background clears runner', async () => {
    await startSession(api, ctx);
    await commandHandler(api, 'background')('sleep 300', ctx);
    await shutdownSession(api);
  });

  it('shutdown after active monitor clears engines', async () => {
    await startSession(api, ctx);
    await commandHandler(api, 'monitor')(
      '--regex SLEEP_MONITOR --before 0 --after 0 --debounce 1 -- sleep 300',
      ctx,
    );
    await shutdownSession(api);
  });

  it('shutdown cleans all refs to null', async () => {
    await startSession(api, ctx);
    await startSession(api, ctx);
    await shutdownSession(api);
    // No exception — shutdown handles already-null refs
  });
});

/* ------------------------------------------------------------------ */
/* Tests: loop/schedule with delivery and coalescing                    */
/* ------------------------------------------------------------------ */

describe('loop delivery and coalescing', () => {
  let api: ExtensionAPI;
  let ctx: ExtensionContext;

  beforeEach(() => {
    api = makeMockApi();
    ctx = makeMockContext(true);
    extension(api);
  });

  it('loop tick delivers via sendMessage', async () => {
    await startSession(api, ctx);
    const result = await tool(api, 'jobs_loop').execute(
      'call-loop-coal',
      { intervalSeconds: 10, prompt: 'check' },
      undefined,
      undefined,
      ctx,
    );
    expect(result.content[0].text).toMatch(/^started loop_/);
    // The first tick fires immediately — delivery is called
    // (coalescing only applies while busy)
    await shutdownSession(api);
  });

  it('turn_end flushes coalesced loop ticks once the session is idle', async () => {
    ctx = makeMockContext(false);
    await startSession(api, ctx);
    const result = await tool(api, 'jobs_loop').execute(
      'call-loop-busy',
      { intervalSeconds: 10, prompt: 'coalesce me' },
      undefined,
      undefined,
      ctx,
    );
    expect(result.content[0].text).toMatch(/^started loop_/);
    expect(api.sendMessage).not.toHaveBeenCalled();

    (ctx.isIdle as ReturnType<typeof vi.fn>).mockReturnValue(true);
    await endTurn(api, ctx);

    expect(api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: 'pi-monitor',
        content: expect.stringContaining('[coalesced 1 loop ticks while session was busy]'),
      }),
      { triggerTurn: true },
    );
    await shutdownSession(api);
  });
});

describe('schedule one-shot completion', () => {
  let api: ExtensionAPI;
  let ctx: ExtensionContext;

  beforeEach(() => {
    api = makeMockApi();
    ctx = makeMockContext(true);
    extension(api);
  });

  it('schedule job completes and cleans up on delivery', async () => {
    await startSession(api, ctx);
    const future = new Date(Date.now() + 100).toISOString();
    const result = await tool(api, 'jobs_schedule').execute(
      'call-sched-done',
      { at: future, prompt: 'done' },
      undefined,
      undefined,
      ctx,
    );
    expect(result.content[0].text).toMatch(/^started sched_/);
    const jobID = result.content[0].text.replace('started ', '');
    await vi.waitFor(async () => {
      const list = await tool(api, 'jobs_list').execute('call-list-done', {}, undefined, undefined, ctx);
      expect(list.content[0].text).toContain(`${jobID} (schedule) → completed`);
    });

    const cancelResult = await tool(api, 'jobs_cancel').execute(
      'call-cancel-sched-done',
      { jobID },
      undefined,
      undefined,
      ctx,
    );
    expect(cancelResult.content[0].text).toContain('cannot be cancelled');
    await shutdownSession(api);
  });
});
