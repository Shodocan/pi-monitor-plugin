import { describe, expect, it } from 'vitest';
import { parseMonitor } from '../src/parser/parse-monitor.ts';

describe('parseMonitor', () => {
  it('parses /pattern/flags with options', () => {
    const result = parseMonitor(
      '--regex /ERROR/iu --before 0 --after 200 --debounce 5 -- tail -f app.log'
    );
    expect(result.regex.flags).toContain('i');
    expect(result.regex.flags).toContain('u');
    expect(result.before).toBe(0);
    expect(result.after).toBe(200);
    expect(result.debounceMs).toBe(5000);
    expect(result.command).toBe('tail -f app.log');
  });

  it('parses plain pattern without slashes', () => {
    const result = parseMonitor('--regex ERROR --debounce 1 -- echo hello');
    expect(result.regex.source).toBe('ERROR');
    expect(result.debounceMs).toBe(1000);
    expect(result.command).toBe('echo hello');
  });

  it('strips shell-style quotes around plain regex patterns', () => {
    expect(parseMonitor("--regex 'MONITOR_FAKE_FIRE' -- echo hello").regex.source)
      .toBe('MONITOR_FAKE_FIRE');
    expect(parseMonitor('--regex "MONITOR_FAKE_FIRE" -- echo hello').regex.source)
      .toBe('MONITOR_FAKE_FIRE');
  });

  it('rejects unsupported flag g', () => {
    expect(() => parseMonitor('--regex /x/g -- echo x')).toThrow('unsupported regex flag');
  });

  it('rejects unsupported flag y', () => {
    expect(() => parseMonitor('--regex /x/y -- echo x')).toThrow('unsupported regex flag');
  });

  it('rejects --before exceeding limit', () => {
    expect(() => parseMonitor('--regex /x/i --before 201 -- echo x')).toThrow('--before');
  });

  it('rejects --after exceeding limit', () => {
    expect(() => parseMonitor('--regex /x/i --after 201 -- echo x')).toThrow('--after');
  });

  it('rejects --debounce below 1', () => {
    expect(() => parseMonitor('--regex /x/i --debounce 0 -- echo x')).toThrow();
  });

  it('rejects --debounce above 60', () => {
    expect(() => parseMonitor('--regex /x/i --debounce 61 -- echo x')).toThrow();
  });

  it('rejects pattern exceeding 512 chars', () => {
    const long = 'x'.repeat(513);
    expect(() => parseMonitor(`--regex ${long} -- echo x`)).toThrow('512');
  });

  it('enforces -- separator before command', () => {
    const r = parseMonitor('--regex /x/i --debounce 1 -- echo hello');
    expect(r.command).toBe('echo hello');
  });

  it('allows i/m/u flags', () => {
    const result = parseMonitor('--regex /test/imu --debounce 1 -- echo ok');
    expect(result.regex.flags).toBe('imu');
  });

  it('rejects empty command after separator', () => {
    expect(() => parseMonitor('--regex /x/i --')).toThrow('command is empty');
  });

  it('uses defaults before=10 after=10 debounceMs=5000', () => {
    const result = parseMonitor('--regex /x/i -- echo ok');
    expect(result.before).toBe(10);
    expect(result.after).toBe(10);
    expect(result.debounceMs).toBe(5000);
  });

  it('tolerates unknown flags (ignored)', () => {
    const result = parseMonitor('--regex /x/i --unknown-thing 42 -- echo ok');
    expect(result.regex.source).toBe('x');
    expect(result.command).toBe('echo ok');
  });

  it('rejects missing -- separator', () => {
    expect(() => parseMonitor('--regex /x/i echo ok')).toThrow('missing -- separator');
  });

  it('rejects missing command after separator', () => {
    expect(() => parseMonitor('--regex /x/i -- ')).toThrow('command is empty');
  });

  describe('embedded -- in regex values', () => {
    it('preserves -- inside delimited regex /pattern/', () => {
      expect(parseMonitor('--regex /a--b/ -- echo x').regex.source).toBe('a--b');
    });

    it('preserves -- inside quoted plain regex', () => {
      expect(parseMonitor("--regex 'a--b' -- echo x").regex.source).toBe('a--b');
    });

    it('preserves -- inside single-quoted value with leading space', () => {
      expect(parseMonitor("--regex 'a --b' -- echo x").regex.source).toBe('a --b');
    });

    it('preserves -- inside delimited regex with spaces around --', () => {
      expect(parseMonitor('--regex /a -- b/ -- echo x').regex.source).toBe('a -- b');
    });

    it('does not treat -- inside double-quoted regex as command separator', () => {
      expect(() => parseMonitor('--regex "a -- b" echo x')).toThrow('missing -- separator');
    });

    it('does not treat -- inside single-quoted regex as command separator', () => {
      expect(() => parseMonitor("--regex 'a -- b' echo x")).toThrow('missing -- separator');
    });

    it('does not treat -- inside delimited regex as command separator', () => {
      expect(() => parseMonitor('--regex /a -- b/ echo x')).toThrow('missing -- separator');
    });
  });

  describe('escaped slash handling', () => {
    it('single backslash before slash escapes it (odd count)', () => {
      const r = parseMonitor('--regex /a\\/b/i -- echo ok');
      expect(r.regex.source).toBe('a\\/b');
      expect(r.regex.flags).toBe('i');
    });

    it('zero backslashes before slash is delimiter (even count)', () => {
      expect(parseMonitor('--regex /x/i -- echo ok').regex.source).toBe('x');
    });

    it('two backslashes before slash is delimiter (even count)', () => {
      const r = parseMonitor('--regex /a\\\\/i -- echo ok');
      expect(r.regex.source).toBe('a\\\\');
      expect(r.regex.flags).toBe('i');
    });

    it('escaped slash remains inside delimited regex pattern', () => {
      const r = parseMonitor('--regex /a\\/b/i -- echo ok');
      expect(r.regex.source).toBe('a\\/b');
      expect(r.regex.flags).toBe('i');
    });
  });
});
