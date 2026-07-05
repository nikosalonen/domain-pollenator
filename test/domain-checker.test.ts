import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calculateNextCheckDate, determineStatus, parseExpirationDate } from '../lambda/domain-checker/index';

describe('parseExpirationDate', () => {
  it('parses ISO dates', () => {
    expect(parseExpirationDate('2026-12-31')).toBe('2026-12-31');
  });

  it('parses ISO timestamps', () => {
    expect(parseExpirationDate('2026-12-31T23:59:59Z')).toBe('2026-12-31');
    expect(parseExpirationDate('2026-12-31T23:59:59.000Z')).toBe('2026-12-31');
  });

  it('parses DD.MM.YYYY with optional time (Finnish registry)', () => {
    expect(parseExpirationDate('13.6.2026 22:56:04')).toBe('2026-06-13');
    expect(parseExpirationDate('13.6.2026')).toBe('2026-06-13');
  });

  it('parses DD-MMM-YYYY and DD MMM YYYY', () => {
    expect(parseExpirationDate('31-Dec-2026')).toBe('2026-12-31');
    expect(parseExpirationDate('31 Dec 2026')).toBe('2026-12-31');
  });

  it('parses DD/MM/YYYY', () => {
    expect(parseExpirationDate('31/12/2026')).toBe('2026-12-31');
  });

  it('parses compact YYYYMMDD', () => {
    expect(parseExpirationDate('20261231')).toBe('2026-12-31');
  });

  it('rejects garbage and implausible years', () => {
    expect(parseExpirationDate('')).toBeNull();
    expect(parseExpirationDate('not a date')).toBeNull();
    expect(parseExpirationDate('9999-99-99')).toBeNull();
    expect(parseExpirationDate('1899-01-01')).toBeNull();
  });
});

describe('date logic (frozen at 2026-07-05 UTC)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-05T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('determineStatus', () => {
    it('flags past dates as expired', () => {
      expect(determineStatus('2026-07-04')).toBe('expired');
    });

    it('flags dates within 7 days as expiring_soon', () => {
      expect(determineStatus('2026-07-10')).toBe('expiring_soon');
      expect(determineStatus('2026-07-12')).toBe('expiring_soon');
    });

    it('flags dates beyond 7 days as active', () => {
      expect(determineStatus('2026-08-05')).toBe('active');
    });
  });

  describe('calculateNextCheckDate', () => {
    it('schedules 3 days before expiration when more than 3 days out', () => {
      expect(calculateNextCheckDate('2026-08-01')).toBe('2026-07-29');
    });

    it('schedules 1 day before expiration when 2-3 days out', () => {
      expect(calculateNextCheckDate('2026-07-08')).toBe('2026-07-07');
    });

    it('schedules 1 day after expiration when 1 day or less out', () => {
      expect(calculateNextCheckDate('2026-07-06')).toBe('2026-07-07');
      expect(calculateNextCheckDate('2026-07-05')).toBe('2026-07-06');
    });

    it('re-checks expired domains after 30 days', () => {
      expect(calculateNextCheckDate('2026-07-01')).toBe('2026-08-04');
    });
  });
});
