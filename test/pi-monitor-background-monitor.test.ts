import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import extension from '../extensions/pi-monitor.ts';

/* ------------------------------------------------------------------ */
/* Mock helpers                                                       */
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

function makeMockContext(): ExtensionContext {
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
    isIdle: vi.fn().mockReturnValue(true),
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
/* Tests: registration                                                 */
/* ------------------------------------------------------------------ */

describe('extension registration', () => {
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

  it('background tool schema has required fields', () => {
    extension(api);
    const calls = (api.registerTool as ReturnType<typeof vi.fn>).mock.calls;
    const bgTool = calls[0][0];
    expect(bgTool.name).toBe('jobs_background');
    expect(bgTool.parameters).toBeDefined();
  });

  it('monitor tool schema has required fields', () => {
    extension(api);
    const calls = (api.registerTool as ReturnType<typeof vi.fn>).mock.calls;
    const monTool = calls[1][0];
    expect(monTool.name).toBe('jobs_monitor');
    expect(monTool.parameters).toBeDefined();
  });

  it('registers lifecycle hooks', () => {
    extension(api);
    const onCalls = (api.on as ReturnType<typeof vi.fn>).mock.calls;
    const events = onCalls.map((c: any[]) => c[0]);
    expect(events).toContain('session_start');
    expect(events).toContain('session_shutdown');
  });
});

describe('session lifecycle', () => {
  let api: ExtensionAPI;
  let ctx: ExtensionContext;

  beforeEach(() => {
    api = makeMockApi();
    ctx = makeMockContext();
    extension(api);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('session_start initializes runtime state and sets status', async () => {
    const startHandler = (api.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: any[]) => c[0] === 'session_start',
    )![1];
    await startHandler({}, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith('pi-monitor', 'jobs idle');
  });

  it('session_shutdown destroys engines and clears delivery', async () => {
    const startHandler = (api.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: any[]) => c[0] === 'session_start',
    )![1];
    await startHandler({}, ctx);

    const shutdownHandler = (api.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: any[]) => c[0] === 'session_shutdown',
    )![1];
    await shutdownHandler({});
    // No exception thrown — shutdown is clean
  });
});

describe('command handlers', () => {
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

  it('schedule command starts a schedule job', async () => {
    await startSession(api, ctx);
    await commandHandler(api, 'schedule')('in 30s say hello', ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/^started sched_/));
    await shutdownSession(api);
  });

  it('jobs command lists jobs', async () => {
    await startSession(api, ctx);
    await commandHandler(api, 'jobs')('', ctx);
    expect(ctx.ui.notify).toHaveBeenCalled();
    await shutdownSession(api);
  });

  it('cancel command warns on empty args', async () => {
    await startSession(api, ctx);
    await commandHandler(api, 'cancel')('  ', ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('Usage'), 'warning');
    await shutdownSession(api);
  });

  it('background command starts a job immediately', async () => {
    await startSession(api, ctx);
    await commandHandler(api, 'background')('printf bg-command', ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/^started bg_/));

    await shutdownSession(api);
  });

  it('background tool returns started job immediately', async () => {
    await startSession(api, ctx);
    const result = await tool(api, 'jobs_background').execute(
      'call-1',
      { command: 'printf bg-tool' },
      undefined,
      undefined,
      ctx,
    );

    expect(result.content[0].text).toMatch(/^started bg_/);

    await shutdownSession(api);
  });

  it('monitor command starts a job immediately', async () => {
    await startSession(api, ctx);
    await commandHandler(api, 'monitor')(
      '--regex MONITOR_CMD --before 0 --after 0 --debounce 1 -- printf MONITOR_CMD',
      ctx,
    );

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/^started mon_/));

    await shutdownSession(api);
  }, 10_000);

  it('monitor tool starts a job and delivers matching output', async () => {
    await startSession(api, ctx);
    const result = await tool(api, 'jobs_monitor').execute(
      'call-2',
      {
        command: 'printf MONITOR_TOOL',
        regex: 'MONITOR_TOOL',
        before: 0,
        after: 0,
        debounceSeconds: 1,
        deliver: 'polite',
      },
      undefined,
      undefined,
      ctx,
    );

    expect(result.content[0].text).toMatch(/^started mon_/);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: 'pi-monitor', display: true }),
      { triggerTurn: true },
    );

    await shutdownSession(api);
  }, 10_000);

  it('monitor tool rejects invalid numeric params before starting a job', async () => {
    await startSession(api, ctx);

    await expect(
      tool(api, 'jobs_monitor').execute(
        'call-3',
        {
          command: 'printf SHOULD_NOT_RUN',
          regex: 'SHOULD_NOT_RUN',
          before: 201,
          after: 0,
          debounceSeconds: 1,
        },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow('before');
    expect(api.sendMessage).not.toHaveBeenCalled();

    await shutdownSession(api);
  });
});

describe('completed jobs release runner state', () => {
  let api: ExtensionAPI;
  let ctx: ExtensionContext;

  beforeEach(() => {
    api = makeMockApi();
    ctx = makeMockContext();
    extension(api);
  });

  it('natural background completion disposes runner handle and tail', async () => {
    await startSession(api, ctx);

    const { ProcessRunner } = await import('../src/runner/process-runner.ts');
    const disposeSpy = vi.spyOn(ProcessRunner.prototype, 'dispose');

    const result = await tool(api, 'jobs_background').execute(
      'call-bg-dispose',
      { command: 'printf bg-dispose' },
      undefined,
      undefined,
      ctx,
    );

    const jobID = (result.content[0].text as string).match(/started (\S+)/)![1];

    await vi.waitFor(() => expect(disposeSpy).toHaveBeenCalledWith(jobID));

    await shutdownSession(api);
  });

  it('cancellation disposes runner handle and tail for background jobs', async () => {
    await startSession(api, ctx);

    const { ProcessRunner } = await import('../src/runner/process-runner.ts');
    const disposeSpy = vi.spyOn(ProcessRunner.prototype, 'dispose');

    const result = await tool(api, 'jobs_background').execute(
      'call-bg-cancel',
      { command: 'sleep 60' },
      undefined,
      undefined,
      ctx,
    );

    const jobID = (result.content[0].text as string).match(/started (\S+)/)![1];

    // Cancel the job
    await tool(api, 'jobs_cancel').execute(
      'call-cancel',
      { jobID },
      undefined,
      undefined,
      ctx,
    );

    await vi.waitFor(() => expect(disposeSpy).toHaveBeenCalledWith(jobID));

    await shutdownSession(api);
  });

  it('cancellation disposes runner handle and tail for monitor jobs', async () => {
    await startSession(api, ctx);

    const { ProcessRunner } = await import('../src/runner/process-runner.ts');
    const disposeSpy = vi.spyOn(ProcessRunner.prototype, 'dispose');

    const result = await tool(api, 'jobs_monitor').execute(
      'call-mon-cancel',
      {
        command: 'sleep 60',
        regex: 'NEVER_MATCHES',
        debounceSeconds: 1,
      },
      undefined,
      undefined,
      ctx,
    );

    const jobID = (result.content[0].text as string).match(/started (\S+)/)![1];

    await tool(api, 'jobs_cancel').execute(
      'call-mon-cancel',
      { jobID },
      undefined,
      undefined,
      ctx,
    );

    await vi.waitFor(() => expect(disposeSpy).toHaveBeenCalledWith(jobID));

    await shutdownSession(api);
  });

  it('session_shutdown disposes all runner handles', async () => {
    await startSession(api, ctx);

    const { ProcessRunner } = await import('../src/runner/process-runner.ts');
    const disposeSpy = vi.spyOn(ProcessRunner.prototype, 'dispose');

    // Start two background jobs
    await tool(api, 'jobs_background').execute(
      'call-shutdown-1',
      { command: 'sleep 60' },
      undefined,
      undefined,
      ctx,
    );
    await tool(api, 'jobs_background').execute(
      'call-shutdown-2',
      { command: 'sleep 60' },
      undefined,
      undefined,
      ctx,
    );

    await shutdownSession(api);

    // Both handles should be disposed by session_shutdown
    expect(disposeSpy).toHaveBeenCalledTimes(2);
  });

  it('natural monitor completion disposes runner handle and tail', async () => {
    await startSession(api, ctx);

    const { ProcessRunner } = await import('../src/runner/process-runner.ts');
    const disposeSpy = vi.spyOn(ProcessRunner.prototype, 'dispose');

    const result = await tool(api, 'jobs_monitor').execute(
      'call-mon-dispose',
      {
        command: 'printf MON_DISPOSE',
        regex: 'MON_DISPOSE',
        debounceSeconds: 1,
      },
      undefined,
      undefined,
      ctx,
    );

    const jobID = (result.content[0].text as string).match(/started (\S+)/)![1];

    await vi.waitFor(() => expect(disposeSpy).toHaveBeenCalledWith(jobID));

    await shutdownSession(api);
  });
});

describe('jobs_monitor validation parity with /monitor', () => {
  let api: ExtensionAPI;
  let ctx: ExtensionContext;

  beforeEach(() => {
    api = makeMockApi();
    ctx = makeMockContext();
    extension(api);
  });

  it('rejects regex pattern exceeding MAX_REGEX_PATTERN_LENGTH before starting a job', async () => {
    await startSession(api, ctx);

    const longPattern = 'x'.repeat(513);

    await expect(
      tool(api, 'jobs_monitor').execute(
        'call-long',
        {
          command: 'printf SHOULD_NOT_RUN',
          regex: longPattern,
          debounceSeconds: 1,
        },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow('512');

    // No job was started — no sendMessage or ui.notify for a monitor job
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringMatching(/^started mon_/));
    expect(api.sendMessage).not.toHaveBeenCalled();

    await shutdownSession(api);
  });

  it('rejects unsupported regex flag g before starting a job', async () => {
    await startSession(api, ctx);

    await expect(
      tool(api, 'jobs_monitor').execute(
        'call-flags-g',
        {
          command: 'printf SHOULD_NOT_RUN',
          regex: 'x',
          regexFlags: 'g',
          debounceSeconds: 1,
        },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow("unsupported regex flag 'g'");

    expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringMatching(/^started mon_/));
    expect(api.sendMessage).not.toHaveBeenCalled();

    await shutdownSession(api);
  });

  it('rejects unsupported regex flag y before starting a job', async () => {
    await startSession(api, ctx);

    await expect(
      tool(api, 'jobs_monitor').execute(
        'call-flags-y',
        {
          command: 'printf SHOULD_NOT_RUN',
          regex: 'x',
          regexFlags: 'y',
          debounceSeconds: 1,
        },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow("unsupported regex flag 'y'");

    expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringMatching(/^started mon_/));
    expect(api.sendMessage).not.toHaveBeenCalled();

    await shutdownSession(api);
  });

  it('accepts supported flags i/m/u and starts job', async () => {
    await startSession(api, ctx);

    const result = await tool(api, 'jobs_monitor').execute(
      'call-flags-imu',
      {
        command: 'printf MATCH',
        regex: 'MATCH',
        regexFlags: 'im',
        debounceSeconds: 1,
      },
      undefined,
      undefined,
      ctx,
    );

    expect(result.content[0].text).toMatch(/^started mon_/);
    await shutdownSession(api);
  });

  it('preserves defaults for before, after, debounceSeconds, and deliver', async () => {
    await startSession(api, ctx);

    const result = await tool(api, 'jobs_monitor').execute(
      'call-defaults',
      {
        command: 'printf DEFAULTS',
        regex: 'DEFAULTS',
      },
      undefined,
      undefined,
      ctx,
    );

    expect(result.content[0].text).toMatch(/^started mon_/);
    await shutdownSession(api);
  });

  it('preserves deliver steer urgency', async () => {
    await startSession(api, ctx);

    const result = await tool(api, 'jobs_monitor').execute(
      'call-steer',
      {
        command: 'printf STEER',
        regex: 'STEER',
        deliver: 'steer',
        debounceSeconds: 1,
      },
      undefined,
      undefined,
      ctx,
    );

    expect(result.content[0].text).toMatch(/^started mon_/);
    await shutdownSession(api);
  });
});
