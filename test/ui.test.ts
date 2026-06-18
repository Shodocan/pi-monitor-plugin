import { describe, expect, it } from 'vitest';
import type { JobRecord } from '../src/types.ts';
import { formatJobStatus, formatJobWidget } from '../src/ui.ts';

function job(overrides: Partial<JobRecord>): JobRecord {
  return {
    jobID: 'mon_1',
    kind: 'mon',
    state: 'active',
    sessionID: 's1',
    createdAt: 1_000,
    ...overrides,
  };
}

describe('formatJobStatus', () => {
  it('returns idle when no active jobs exist', () => {
    expect(formatJobStatus([])).toBe('jobs idle');
  });

  it('summarizes active jobs by kind in a compact footer string', () => {
    expect(
      formatJobStatus([
        job({ jobID: 'bg_1', kind: 'bg' }),
        job({ jobID: 'mon_2', kind: 'mon' }),
        job({ jobID: 'mon_3', kind: 'mon' }),
        job({ jobID: 'loop_4', kind: 'loop' }),
      ]),
    ).toBe('jobs bg:1 mon:2 loop:1');
  });
});

describe('formatJobWidget', () => {
  it('hides the widget when no active jobs exist', () => {
    expect(formatJobWidget([], 10_000)).toBeUndefined();
  });

  it('renders bounded active job lines with elapsed time and truncated summary', () => {
    const lines = formatJobWidget(
      [
        job({
          jobID: 'mon_1',
          kind: 'mon',
          createdAt: 0,
          summary: 'watch-prs.sh --interval 300 --repo acme-org/example-service',
        }),
        job({ jobID: 'loop_2', kind: 'loop', createdAt: 3_000, summary: 'every 300s: check review queue' }),
      ],
      65_000,
    );

    expect(lines).toEqual([
      'pi-monitor jobs',
      'mon_1  1m  watch-prs.sh --interval 300 --repo acme-org/example…',
      'loop_2  1m  every 300s: check review queue',
    ]);
  });

  it('caps the active job list and reports hidden jobs', () => {
    const jobs = Array.from({ length: 7 }, (_, i) =>
      job({ jobID: `mon_${i + 1}`, kind: 'mon', summary: `monitor ${i + 1}` }),
    );

    const lines = formatJobWidget(jobs, 10_000);
    expect(lines).toHaveLength(7);
    expect(lines?.at(-1)).toBe('…and 2 more active jobs');
  });
});