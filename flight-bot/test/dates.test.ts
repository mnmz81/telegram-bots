import { describe, expect, it } from 'vitest';
import { isClosed, israelNow, monthOptions, weekendPairs } from '../src/dates';

describe('weekendPairs', () => {
  it('lists every Thursday-to-Monday pair in December 2026', () => {
    expect(weekendPairs('2026-12', 'thu', '2026-10-22')).toEqual([
      { out: '2026-12-03', ret: '2026-12-07' },
      { out: '2026-12-10', ret: '2026-12-14' },
      { out: '2026-12-17', ret: '2026-12-21' },
      { out: '2026-12-24', ret: '2026-12-28' },
      { out: '2026-12-31', ret: '2027-01-04' },
    ]);
  });
  it('starts on Wednesday for the wed pattern', () => {
    expect(weekendPairs('2026-12', 'wed', '2026-10-22')[0]).toEqual({ out: '2026-12-02', ret: '2026-12-07' });
  });
  it('returns both patterns, 10 pairs in December', () => {
    expect(weekendPairs('2026-12', 'both', '2026-10-22')).toHaveLength(10);
  });
  it('skips dates not after the cutoff', () => {
    expect(weekendPairs('2026-10', 'thu', '2026-10-22')).toEqual([{ out: '2026-10-29', ret: '2026-11-02' }]);
  });
});

describe('israelNow', () => {
  it('maps winter UTC+2', () => {
    expect(israelNow(new Date('2026-12-01T09:00:00Z')).hour).toBe(11);
  });
  it('maps summer UTC+3', () => {
    expect(israelNow(new Date('2026-07-01T08:00:00Z')).hour).toBe(11);
  });
});

describe('isClosed', () => {
  it('is open at 23:00 Israel on 31 Dec', () => {
    expect(isClosed(new Date('2026-12-31T21:00:00Z'))).toBe(false);
  });
  it('is closed at 00:30 Israel on 1 Jan', () => {
    expect(isClosed(new Date('2026-12-31T22:30:00Z'))).toBe(true);
  });
});

describe('monthOptions', () => {
  it('stops at the search-until month', () => {
    expect(monthOptions(new Date('2026-10-22T12:00:00Z'))).toEqual(['2026-10', '2026-11', '2026-12']);
  });
});
