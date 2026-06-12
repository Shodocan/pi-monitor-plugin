import { describe, expect, it } from 'vitest';
import { parseBackground } from '../src/parser/parse-background.ts';
import { parseLoop } from '../src/parser/parse-loop.ts';
import { parseSchedule } from '../src/parser/parse-schedule.ts';
import { parseDuration, parseDate } from '../src/parser/time-utils.ts';

describe('parseBackground', () => {
  it('strips outer double quotes', () => {
    expect(parseBackground(' "npm test" ').command).toBe('npm test');
  });

  it('strips outer single quotes', () => {
    expect(parseBackground(" 'npm test' ").command).toBe('npm test');
  });

  it('works without quotes', () => {
    expect(parseBackground('  npm run build  ').command).toBe('npm run build');
  });

  it('rejects empty command', () => {
    expect(() => parseBackground('   ')).toThrow('empty');
    expect(() => parseBackground('""')).toThrow('empty');
    expect(() => parseBackground("''")).toThrow('empty');
  });

  it('rejects quoted whitespace-only strings', () => {
    expect(() => parseBackground('"   "')).toThrow('empty');
    expect(() => parseBackground("'   '")).toThrow('empty');
  });
});

describe('parseDuration (time-utils)', () => {
  it('rejects unsupported unit "d"', () => {
    expect(() => parseDuration('5d')).toThrow('unsupported unit');
  });

  it('rejects unsupported unit "w"', () => {
    expect(() => parseDuration('2w')).toThrow('unsupported unit');
  });

  it('rejects malformed durations without unit', () => {
    expect(() => parseDuration('123')).toThrow('invalid format');
  });

  it('rejects malformed durations with multiple units', () => {
    expect(() => parseDuration('10s3m')).toThrow('invalid format');
  });

  it('handles leading zeros (e.g. 05s = 5000ms)', () => {
    expect(parseDuration('05s')).toBe(5_000);
  });

  it('handles zero duration (0s = 0ms)', () => {
    expect(parseDuration('0s')).toBe(0);
  });

  it('parses large values', () => {
    expect(parseDuration('10h')).toBe(10 * 60 * 60 * 1000);
  });
});

describe('parseLoop', () => {
  it('parses 30s interval', () => {
    const result = parseLoop('30s echo hello');
    expect(result.intervalMs).toBe(30_000);
    expect(result.prompt).toBe('echo hello');
  });

  it('parses 5m interval', () => {
    const result = parseLoop('5m run tests');
    expect(result.intervalMs).toBe(5 * 60 * 1000);
    expect(result.prompt).toBe('run tests');
  });

  it('rejects below 10s minimum', () => {
    expect(() => parseLoop('5s hello')).toThrow('minimum');
  });

  it('rejects empty prompt', () => {
    expect(() => parseLoop('30s')).toThrow('prompt');
  });

  it('rejects day unit (d) via parseDuration', () => {
    expect(() => parseLoop('5d check')).toThrow('unsupported unit');
  });
});

describe('parseSchedule', () => {
  it('parses "in 10m" schedule', () => {
    const now = new Date();
    const result = parseSchedule('in 10m run tests', now);
    expect(result.prompt).toBe('run tests');
    expect(result.runAt.getTime()).toBeCloseTo(now.getTime() + 10 * 60 * 1000, 0);
  });

  it('parses "in 1h" schedule', () => {
    const result = parseSchedule('in 1h deploy');
    expect(result.prompt).toBe('deploy');
    expect(result.runAt.getTime() > Date.now()).toBe(true);
  });

  it('parses "in 60s" schedule', () => {
    const result = parseSchedule('in 60s check');
    expect(result.prompt).toBe('check');
    expect(result.runAt.getTime() > Date.now()).toBe(true);
  });

  it('calculates "in" runAt relative to the provided reference time', () => {
    const farRef = new Date(Date.now() + 60 * 60 * 1000);
    const result = parseSchedule('in 60s run', farRef);
    expect(result.runAt.getTime() > Date.now()).toBe(true);
  });

  it('rejects "at" target in the past', () => {
    const isoPast = '2020-01-01T00:00:00';
    expect(() => parseSchedule(`at ${isoPast} run`)).toThrow('future');
  });

  it('rejects duration with "d" unit', () => {
    expect(() => parseSchedule('in 5d check')).toThrow('not d');
  });

  it('rejects "in" with zero duration', () => {
    expect(() => parseSchedule('in 0s check')).toThrow('positive');
  });

  it('rejects "in" with zero minutes duration', () => {
    expect(() => parseSchedule('in 0m check')).toThrow('positive');
  });

  it('accepts "at" with future ISO date', () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const result = parseSchedule(`at ${future} deploy`);
    expect(result.prompt).toBe('deploy');
    expect(result.runAt.getTime() > Date.now()).toBe(true);
  });

  it('rejects schedule beyond 30-day horizon', () => {
    const far = new Date(Date.now() + 50 * 24 * 60 * 60 * 1000).toISOString();
    expect(() => parseSchedule(`at ${far} deploy`)).toThrow('30-day');
  });

  it('rejects "in" with no prompt', () => {
    expect(() => parseSchedule('in 10m')).toThrow('prompt');
  });

  it('rejects "in" with whitespace-only prompt', () => {
    expect(() => parseSchedule('in 10m   ')).toThrow('prompt');
  });

  it('rejects "in" no separator between duration and prompt', () => {
    expect(() => parseSchedule('in 10ms run')).toThrow('invalid duration');
  });

  it('rejects "in" no separator (letter glued to unit)', () => {
    expect(() => parseSchedule('in 5mrun')).toThrow('invalid duration');
  });

  it('rejects "at" no separator between date and prompt', () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    expect(() => parseSchedule(`at ${future}run`)).toThrow('invalid ISO');
  });

  it('rejects "at" with no prompt', () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    expect(() => parseSchedule(`at ${future}`)).toThrow('prompt');
  });

  it('rejects "at" with whitespace-only prompt', () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    expect(() => parseSchedule(`at ${future}   `)).toThrow('prompt');
  });
});

describe('parseDate (time-utils)', () => {
  it('parses valid ISO date', () => {
    const d = parseDate('2025-06-15T10:00:00Z');
    expect(d.getTime()).toBe(1749981600000);
  });

  it('accepts ISO without timezone (local)', () => {
    const d = parseDate('2025-06-15T10:00:00');
    expect(Number.isNaN(d.getTime())).toBe(false);
  });

  it('rejects malformed ISO (not a datetime)', () => {
    expect(() => parseDate('not-a-date')).toThrow('cannot parse');
  });

  it('accepts plain date-only string', () => {
    const d = parseDate('2025-06-15');
    expect(Number.isNaN(d.getTime())).toBe(false);
  });
});
