import { describe, expect, it } from 'vitest';
import { JobRegistry } from '../src/registry.ts';
import type { JobKind } from '../src/types.ts';
import { MAX_ACTIVE_JOBS, MAX_COMPLETED_RETENTION } from '../src/limits.ts';

describe('JobRegistry', () => {
  function mk(kind: JobKind = 'bg'): [JobRegistry, string] {
    const reg = new JobRegistry('test-session');
    const jobID = reg.register(kind);
    return [reg, jobID];
  }

  // -- ID generation -----------------------------------------------

  it('generates IDs as <kind>_<counter>', () => {
    const reg = new JobRegistry('sess');
    expect(reg.register('bg')).toBe('bg_1');
    expect(reg.register('mon')).toBe('mon_2');
    expect(reg.register('loop')).toBe('loop_3');
  });

  it('counter increments independently per registry instance', () => {
    const a = new JobRegistry('a');
    const b = new JobRegistry('b');
    expect(a.register('bg')).toBe('bg_1');
    expect(b.register('bg')).toBe('bg_1');
  });

  it('supports all four JobKind values', () => {
    const reg = new JobRegistry('s');
    for (const kind of ['bg', 'mon', 'loop', 'sched'] as JobKind[]) {
      expect(reg.register(kind)).toMatch(new RegExp(`^${kind}_\\d+$`));
    }
  });

  // -- sessionID ownership -----------------------------------------

  it('records owns sessionID directly', () => {
    const reg = new JobRegistry('sess-123');
    const id = reg.register('bg');
    const rec = reg.get(id);
    expect(rec?.sessionID).toBe('sess-123');
  });

  // -- cap enforcement ---------------------------------------------

  it('rejects registration beyond MAX_ACTIVE_JOBS', () => {
    const reg = new JobRegistry('s');
    for (let i = 0; i < MAX_ACTIVE_JOBS; i++) reg.register('bg');
    expect(reg.activeCount).toBe(MAX_ACTIVE_JOBS);
    expect(() => reg.register('bg')).toThrow(
      `max active jobs (${MAX_ACTIVE_JOBS})`,
    );
  });

  it('allows new registration after cancelling one', () => {
    const reg = new JobRegistry('s');
    const ids: string[] = [];
    for (let i = 0; i < MAX_ACTIVE_JOBS; i++) ids.push(reg.register('bg'));
    reg.cancel(ids[0]);
    expect(reg.activeCount).toBe(MAX_ACTIVE_JOBS - 1);
    const newId = reg.register('mon');
    expect(newId).toBeDefined();
    expect(reg.activeCount).toBe(MAX_ACTIVE_JOBS);
  });

  // -- State transitions -------------------------------------------

  it('transitions active -> completed via complete()', () => {
    const [reg, jobID] = mk();
    reg.complete(jobID);
    expect(reg.get(jobID)?.state).toBe('completed');
    expect(reg.activeCount).toBe(0);
  });

  it('transitions active -> failed via fail()', () => {
    const [reg, jobID] = mk();
    reg.fail(jobID);
    expect(reg.get(jobID)?.state).toBe('failed');
    expect(reg.activeCount).toBe(0);
  });

  it('transitions active -> cancelled via cancel()', () => {
    const [reg, jobID] = mk();
    reg.cancel(jobID);
    expect(reg.get(jobID)?.state).toBe('cancelled');
    expect(reg.activeCount).toBe(0);
  });

  // -- Cancellation errors ----------------------------------------

  it('throws "not found" for unknown jobID on cancel', () => {
    const [reg] = mk();
    expect(() => reg.cancel('ghost_0')).toThrow('Error: job ghost_0 not found.');
  });

  it('throws "cannot be cancelled" for cancelled job', () => {
    const [reg, jobID] = mk();
    reg.cancel(jobID);
    expect(() => reg.cancel(jobID)).toThrow(
      `Error: job ${jobID} cannot be cancelled (state: cancelled).`,
    );
  });

  it('throws "cannot be cancelled" for completed job', () => {
    const [reg, jobID] = mk();
    reg.complete(jobID);
    expect(() => reg.cancel(jobID)).toThrow(
      `Error: job ${jobID} cannot be cancelled (state: completed).`,
    );
  });

  it('throws "cannot be cancelled" for failed job', () => {
    const [reg, jobID] = mk();
    reg.fail(jobID);
    expect(() => reg.cancel(jobID)).toThrow(
      `Error: job ${jobID} cannot be cancelled (state: failed).`,
    );
  });

  // -- Session filtering -------------------------------------------

  it('bySession returns only matching jobs', () => {
    const reg = new JobRegistry('sess-a');
    reg.register('bg');
    reg.register('mon');
    const found = reg.bySession('sess-a');
    expect(found).toHaveLength(2);

    const empty = reg.bySession('sess-b');
    expect(empty).toHaveLength(0);
  });

  it('bySession includes completed jobs', () => {
    const reg = new JobRegistry('sess-a');
    const id = reg.register('bg');
    reg.complete(id);
    const found = reg.bySession('sess-a');
    expect(found).toHaveLength(1);
    expect(found[0].state).toBe('completed');
  });

  // -- Completed retention -----------------------------------------

  it('trims completed list to MAX_COMPLETED_RETENTION', () => {
    const reg = new JobRegistry('s');
    for (let i = 0; i < MAX_COMPLETED_RETENTION + 5; i++) {
      const id = reg.register('bg');
      reg.cancel(id);
    }
    expect(reg.activeCount).toBe(0);
    expect(reg.completed()).toHaveLength(MAX_COMPLETED_RETENTION);
  });

  it('list() returns active + completed sorted by createdAt desc', () => {
    const reg = new JobRegistry('s');
    const id1 = reg.register('bg');
    const id2 = reg.register('mon');
    reg.complete(id1);
    const list = reg.list();
    expect(list).toHaveLength(2);
    expect(list[0].jobID).toBe(id2); // newer first
    expect(list[1].jobID).toBe(id1);
  });

  // -- active() / completed() ------------------------------------

  it('active() returns only active jobs', () => {
    const reg = new JobRegistry('s');
    const id1 = reg.register('bg');
    const id2 = reg.register('mon');
    reg.complete(id1);
    expect(reg.active()).toHaveLength(1);
    expect(reg.active()[0].jobID).toBe(id2);
  });

  it('completed() returns only completed jobs', () => {
    const reg = new JobRegistry('s');
    const id1 = reg.register('bg');
    const id2 = reg.register('mon');
    reg.complete(id1);
    reg.cancel(id2);
    expect(reg.completed()).toHaveLength(2);
  });

  // -- get() -----------------------------------------------------

  it('get() returns undefined for unknown ID', () => {
    const [reg] = mk();
    expect(reg.get('nonexistent_99')).toBeUndefined();
  });

  it('get() finds completed jobs', () => {
    const [reg, jobID] = mk();
    reg.complete(jobID);
    expect(reg.get(jobID)).toBeDefined();
    expect(reg.get(jobID)?.state).toBe('completed');
  });

  // -- activeCount -------------------------------------------------

  it('tracks active count accurately', () => {
    const reg = new JobRegistry('s');
    expect(reg.activeCount).toBe(0);
    reg.register('bg');
    expect(reg.activeCount).toBe(1);
    reg.register('mon');
    expect(reg.activeCount).toBe(2);
    const ids = [reg.register('loop'), reg.register('sched')];
    expect(reg.activeCount).toBe(4);
    reg.cancel(ids[0]);
    reg.fail(ids[1]);
    expect(reg.activeCount).toBe(2);
  });
});
