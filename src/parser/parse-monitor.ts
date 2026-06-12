/** Parse a monitor slash command: --regex ... -- <command>. */
import {
  MAX_REGEX_PATTERN_LENGTH,
  MIN_MONITOR_DEBOUNCE_S,
  MAX_MONITOR_DEBOUNCE_S,
} from '../limits.ts';

const MAX_MONITOR_CONTEXT_LINES = 200;

function findSeparator(raw: string): number {
  const positions = findStandaloneDashes(raw);
  return positions.length > 0 ? positions[positions.length - 1] : -1;
}

/**
 * Return positions of standalone "--" tokens that appear outside quoted strings
 * and delimited regex values. Both leading and trailing boundaries must be
 * whitespace or string ends.
 */
function findStandaloneDashes(raw: string): number[] {
  const positions: number[] = [];
  let inQuote = false;
  let inRegex = false;
  let quoteChar = "";
  let i = 0;

  while (i < raw.length) {
    const ch = raw[i];

    // Track quote state
    if ((ch === "'" || ch === '"') && !inRegex) {
      if (!inQuote) {
        inQuote = true;
        quoteChar = ch;
      } else if (ch === quoteChar) {
        inQuote = false;
        quoteChar = "";
      }
      i++;
      continue;
    }

    // Track regex delimiter state
    if (ch === '/' && !inQuote) {
      const bsCount = countConsecutiveBackslashes(raw, i - 1);
      if (bsCount % 2 === 0) inRegex = !inRegex;
      i++;
      continue;
    }

    // Check for standalone "--" (whitespace or boundary on both sides)
    if (ch === '-' && i + 1 < raw.length && raw[i + 1] === '-') {
      const okBefore = i === 0 || raw[i - 1] === ' ';
      const okAfter = i + 2 >= raw.length || raw[i + 2] === ' ';
      if (okBefore && okAfter && !inQuote && !inRegex) {
        positions.push(i);
        i += 3;
        continue;
      }
    }

    i++;
  }

  return positions;
}

function splitFlags(raw: string): string[] {
  const positions = findFlagDashes(raw);
  if (positions.length === 0) return [raw];

  const parts: string[] = [];
  let prev = 0;
  for (const p of positions) {
    parts.push(raw.slice(prev, p));
    prev = p + 2;
  }
  parts.push(raw.slice(prev));
  return parts;
}

/**
 * Return positions of flag-introducing "--" prefixes. Unlike the command
 * separator, a flag prefix is followed immediately by a flag name
 * (`--regex`, `--before`, ...), so only the leading boundary is required.
 * Quoted strings and delimited regex bodies are skipped so regex values such
 * as `/a -- b/` and `'a --b'` stay intact.
 */
function findFlagDashes(raw: string): number[] {
  const positions: number[] = [];
  let inQuote = false;
  let inRegex = false;
  let quoteChar = '';

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];

    if ((ch === "'" || ch === '"') && !inRegex) {
      if (!inQuote) {
        inQuote = true;
        quoteChar = ch;
      } else if (ch === quoteChar) {
        inQuote = false;
        quoteChar = '';
      }
      continue;
    }

    if (ch === '/' && !inQuote) {
      const bsCount = countConsecutiveBackslashes(raw, i - 1);
      if (bsCount % 2 === 0) inRegex = !inRegex;
      continue;
    }

    if (!inQuote && !inRegex && ch === '-' && raw[i + 1] === '-') {
      const okBefore = i === 0 || raw[i - 1] === ' ';
      if (okBefore) positions.push(i);
      i++;
    }
  }

  return positions;
}

function countConsecutiveBackslashes(s: string, from: number): number {
  let count = 0;
  let i = from;
  while (i >= 0 && s[i] === '\\') {
    count++;
    i--;
  }
  return count;
}

function stripWrappingQuotes(raw: string): string {
  if (raw.length < 2) return raw;
  const quote = raw[0];
  if ((quote !== "'" && quote !== '"') || raw[raw.length - 1] !== quote) return raw;
  const body = raw.slice(1, -1);
  if (quote === "'") return body;
  return body.replace(/\\(["\\])/g, '$1');
}

function parseRegex(rawInput: string): { pattern: string; flags: string } {
  const raw = stripWrappingQuotes(rawInput.trim());
  if (raw.startsWith('/')) {
    let pos = 1;
    while (pos < raw.length) {
      if (raw[pos] === '/') {
        const bsCount = countConsecutiveBackslashes(raw, pos - 1);
        if (bsCount % 2 === 0) break;
      }
      pos++;
    }
    if (pos >= raw.length) throw new Error('parseMonitor: unclosed regex pattern');
    const pattern = raw.slice(1, pos);
    const flags = raw.slice(pos + 1).trim();
    if (pattern.length > MAX_REGEX_PATTERN_LENGTH)
      throw new Error(`parseMonitor: regex pattern exceeds ${MAX_REGEX_PATTERN_LENGTH} characters`);
    return { pattern, flags };
  }
  if (raw.length > MAX_REGEX_PATTERN_LENGTH)
    throw new Error(`parseMonitor: pattern exceeds ${MAX_REGEX_PATTERN_LENGTH} characters`);
  return { pattern: raw, flags: '' };
}

function checkFlags(flags: string): void {
  for (const ch of flags) {
    if (ch === 'g') throw new Error("parseMonitor: unsupported regex flag 'g'");
    if (ch === 'y') throw new Error("parseMonitor: unsupported regex flag 'y'");
  }
}

export function parseMonitor(raw: string): {
  regex: RegExp;
  before: number;
  after: number;
  debounceMs: number;
  command: string;
} {
  const sep = findSeparator(raw);
  if (sep < 0) throw new Error('parseMonitor: missing -- separator before command');

  const command = raw.slice(sep + 2).trim();
  if (command.length === 0) throw new Error('parseMonitor: command is empty');

  const flagsPart = raw.slice(0, sep).trim();
  let regex: RegExp | null = null;
  let before: number | null = null;
  let after: number | null = null;
  let debounce: number | null = null;
  let hasRegex = false;

  const segments = splitFlags(flagsPart);
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i].trim();
    if (seg.length === 0) continue;
    if (seg.startsWith('regex ')) {
      hasRegex = true;
      const rstr = seg.slice(6).trim();
      const { pattern, flags } = parseRegex(rstr);
      checkFlags(flags);
      regex = new RegExp(pattern, flags);
    } else if (seg.startsWith('before ')) {
      const n = Number(seg.slice(7).trim());
      if (!Number.isInteger(n) || n < 0 || n > MAX_MONITOR_CONTEXT_LINES)
        throw new Error(`parseMonitor: --before must be 0..${MAX_MONITOR_CONTEXT_LINES}, got ${n}`);
      before = n;
    } else if (seg.startsWith('after ')) {
      const n = Number(seg.slice(6).trim());
      if (!Number.isInteger(n) || n < 0 || n > MAX_MONITOR_CONTEXT_LINES)
        throw new Error(`parseMonitor: --after must be 0..${MAX_MONITOR_CONTEXT_LINES}, got ${n}`);
      after = n;
    } else if (seg.startsWith('debounce ')) {
      const n = Number(seg.slice(9).trim());
      if (!Number.isInteger(n) || n < MIN_MONITOR_DEBOUNCE_S || n > MAX_MONITOR_DEBOUNCE_S)
        throw new Error(
          `parseMonitor: --debounce must be ${MIN_MONITOR_DEBOUNCE_S}..${MAX_MONITOR_DEBOUNCE_S}, got ${n}`
        );
      debounce = n;
    }
  }

  if (!hasRegex) throw new Error('parseMonitor: --regex is required');
  if (debounce === null) debounce = 5;
  return {
    regex: regex!,
    before: before ?? 10,
    after: after ?? 10,
    debounceMs: debounce * 1_000,
    command,
  };
}
