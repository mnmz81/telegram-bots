import { describe, expect, it } from 'vitest';
import { fmtLeg, fmtPair, fmtPrice, noticeText } from '../src/messages';

describe('formatting', () => {
  it('formats prices as shekels with thousands separators', () => {
    expect(fmtPrice(1234)).toBe('₪1,234');
  });
  it('formats a same-month pair', () => {
    expect(fmtPair({ out: '2026-12-03', ret: '2026-12-07' })).toBe('\u20663–7.12\u2069');
  });
  it('formats a pair that crosses the year', () => {
    expect(fmtPair({ out: '2026-12-31', ret: '2027-01-04' })).toBe('\u206631.12–4.1\u2069');
  });
  it('formats a leg with airline and times', () => {
    expect(fmtLeg({ airline: 'Austrian', flightNumber: 'OS 858', departAt: '2026-12-03 10:15', arriveAt: '2026-12-03 12:45' })).toBe(
      '\u2066Austrian 10:15→12:45\u2069',
    );
  });
});

describe('noticeText', () => {
  it('shows the new and old price of a chosen-flight drop', () => {
    const t = noticeText({ kind: 'chosen_drop', price: 1800, was: 1900, label: '3–7.12' });
    expect(t).toContain('₪1,800');
    expect(t).toContain('₪1,900');
  });
});
