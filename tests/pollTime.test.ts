import { describe, expect, it } from 'vitest';
import { pollTimeRemaining } from '../lib/poll-time';

describe('poll remaining time', () => {
  it.each([
    [24 * 60, '(24 hours left)'],
    [61, '(2 hours left)'],
    [60, '(1 hour left)'],
    [25, '(25 minutes left)'],
    [0.5, '(1 minute left)'],
    [0, 'Closed'],
  ])('formats %s minutes remaining', (minutes, expected) => {
    expect(pollTimeRemaining('open', 1000 + Number(minutes) * 60_000, 1000)).toBe(expected);
  });
  it('never shows remaining time for cancelled or closed polls', () => {
    expect(pollTimeRemaining('cancelled', 999999, 1000)).toBe('Cancelled');
    expect(pollTimeRemaining('closed', 999999, 1000)).toBe('Closed');
    expect(pollTimeRemaining('preparing', undefined, 1000)).toBe('Preparing');
  });
});
