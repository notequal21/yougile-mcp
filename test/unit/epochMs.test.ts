import { describe, expect, it } from 'vitest';
import { EpochMs } from '../../src/tools/_shared.js';

describe('shared EpochMs', () => {
  it.each([
    ['2026-10-20T00:30:00+05:00', '2026-10-19T19:30:00.000Z'],
    ['2026-10-20T23:30:00-05:00', '2026-10-21T04:30:00.000Z'],
    ['2026-10-20', '2026-10-20T00:00:00.000Z'],
  ])('accepts %s as %s', (input, iso) => {
    expect(EpochMs.parse(input)).toBe(Date.parse(iso));
  });

  it.each([
    '2026-02-30',
    '2025-02-29',
    '2026-13-01',
    '2026-10-20T24:00:00Z',
    '2026-10-20T12:00:00+24:00',
    -1,
    1.5,
  ])('rejects invalid epoch/date %s', (input) => {
    expect(EpochMs.safeParse(input).success).toBe(false);
  });
});
