import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { DeliveryService, type PendingDelivery, type DeliveryUrgency } from '../src/delivery.ts';

// ----------------------------------------------------------------
// Mock factories
// ----------------------------------------------------------------

function createMockPi(): ExtensionAPI {
  return {
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
  } as unknown as ExtensionAPI;
}

function createMockCtx(isIdle = true): ExtensionContext {
  return {
    isIdle: vi.fn(() => isIdle),
    hasUI: true,
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
    mode: 'tui',
    cwd: '/tmp',
    sessionManager: {} as any,
    modelRegistry: {} as any,
    signal: undefined,
    abort: vi.fn(),
    hasPendingMessages: vi.fn(() => false),
    shutdown: vi.fn(),
  } as unknown as ExtensionContext;
}

function makePending(
  overrides: Partial<PendingDelivery> = {},
): PendingDelivery {
  return {
    jobID: 'loop_1',
    kind: 'loop',
    content: 'check status',
    urgency: 'polite' as DeliveryUrgency,
    isProcessOutput: false,
    isLoopTick: false,
    ...overrides,
  };
}

// ----------------------------------------------------------------
// Tests
// ----------------------------------------------------------------

describe('DeliveryService.deliver', () => {
  let ds: DeliveryService;
  let pi: ExtensionAPI;
  let ctx: ExtensionContext;

  beforeEach(() => {
    ds = new DeliveryService();
    pi = createMockPi();
    ctx = createMockCtx(true);
  });

  it('idle sends pi-monitor customType with triggerTurn true', () => {
    ds.deliver(pi, ctx, makePending({ isProcessOutput: false }));

    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: 'pi-monitor',
        content: 'check status',
        display: true,
      }),
      { triggerTurn: true },
    );
  });

  it('busy polite uses deliverAs nextTurn and sends UI toast', () => {
    const busyCtx = createMockCtx(false);
    ds.deliver(pi, busyCtx, makePending({ urgency: 'polite', isProcessOutput: false }));

    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: 'pi-monitor',
        content: 'check status',
        display: true,
      }),
      { deliverAs: 'nextTurn' },
    );
    expect(busyCtx.ui.notify).toHaveBeenCalled();
  });

  it('busy interrupt uses deliverAs steer', () => {
    const busyCtx = createMockCtx(false);
    ds.deliver(pi, busyCtx, makePending({ urgency: 'interrupt', isProcessOutput: false }));

    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: 'pi-monitor',
        content: 'check status',
        display: true,
      }),
      { deliverAs: 'steer' },
    );
  });

  it('process output is nonce-fenced via delivery-format', () => {
    ds.deliver(pi, ctx, makePending({ content: 'BUILD PASSED', isProcessOutput: true }));

    const call = vi.mocked(pi.sendMessage).mock.calls[0][0];
    // The content is wrapped by formatDelivery: nonce / directive / body / nonce
    expect(typeof call.content).toBe('string');
    if (typeof call.content !== 'string') throw new Error('expected string content');
    const lines = call.content.split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(lines[1]).toBe('monitor triggered.');
    expect(lines.includes('BUILD PASSED')).toBe(true);
  });

  it('raw loop prompt without process output is not nonce-wrapped', () => {
    ds.deliver(pi, ctx, makePending({ isProcessOutput: false, isLoopTick: false }));

    const call = vi.mocked(pi.sendMessage).mock.calls[0][0];
    expect(call.content).toBe('check status');
  });

  it('UI guard: no toast when hasUI is false', () => {
    const noUiCtx = createMockCtx(false);
    noUiCtx.hasUI = false;
    noUiCtx.ui = { notify: vi.fn() } as any;
    ds.deliver(pi, noUiCtx, makePending({ urgency: 'polite', isProcessOutput: false }));

    expect(noUiCtx.ui.notify).not.toHaveBeenCalled();
  });
});

describe('DeliveryService loop coalescing', () => {
  let ds: DeliveryService;
  let pi: ExtensionAPI;
  let ctx: ExtensionContext;
  let busyCtx: ExtensionContext;

  beforeEach(() => {
    ds = new DeliveryService();
    pi = createMockPi();
    ctx = createMockCtx(true);
    busyCtx = createMockCtx(false);
  });

  it('coalesces loop ticks while busy, keeping latest', () => {
    const tick1 = makePending({ jobID: 'loop_1', content: 'tick 1', isLoopTick: true });
    const tick2 = makePending({ jobID: 'loop_1', content: 'tick 2', isLoopTick: true });
    const tick3 = makePending({ jobID: 'loop_1', content: 'tick 3', isLoopTick: true });

    ds.deliver(pi, busyCtx, tick1);
    ds.deliver(pi, busyCtx, tick2);
    ds.deliver(pi, busyCtx, tick3);

    // While busy, coalesced ticks do NOT call sendMessage.
    expect(pi.sendMessage).not.toHaveBeenCalled();

    // Flush when session becomes idle.
    const flushed = ds.flushCoalescedLoop(pi, ctx, 'loop_1');
    expect(flushed).toBe(true);

    const call = vi.mocked(pi.sendMessage).mock.calls[0][0];
    expect(call.content).toContain('[coalesced 3 loop ticks while session was busy]');
    expect(call.content).toContain('tick 3');
    expect(ds.flushCoalescedLoop(pi, ctx, 'loop_1')).toBe(false);
  });

  it('flush returns false while session is still busy and keeps bucket for later', () => {
    const tick = makePending({ jobID: 'loop_1', content: 'tick', isLoopTick: true });
    ds.deliver(pi, busyCtx, tick);

    expect(ds.flushCoalescedLoop(pi, busyCtx, 'loop_1')).toBe(false);
    expect(pi.sendMessage).not.toHaveBeenCalled();

    expect(ds.flushCoalescedLoop(pi, ctx, 'loop_1')).toBe(true);
  });

  it('flush returns false when no coalesced bucket exists', () => {
    const flushed = ds.flushCoalescedLoop(pi, ctx, 'loop_99');
    expect(flushed).toBe(false);
  });

  it('clear removes coalescing state', () => {
    const tick = makePending({ jobID: 'loop_1', content: 'tick', isLoopTick: true });
    ds.deliver(pi, busyCtx, tick);

    ds.clear();

    // After clear, flush finds nothing.
    const flushed = ds.flushCoalescedLoop(pi, ctx, 'loop_1');
    expect(flushed).toBe(false);
  });

  it('shutdown clears all pending coalesced state', () => {
    const tick = makePending({ jobID: 'loop_1', content: 'tick', isLoopTick: true });
    ds.deliver(pi, busyCtx, tick);

    // Simulate session_shutdown.
    ds.clear();

    // No buckets remain.
    expect(ds.flushCoalescedLoop(pi, ctx, 'loop_1')).toBe(false);
  });
});
