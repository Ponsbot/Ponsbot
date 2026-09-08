import { expect, it } from 'vitest';
import { pollLeadingOptions } from '../lib/polls';
it('shows the highest three options using shares of votes cast', () => {
  expect(pollLeadingOptions(['A', 'B', 'C', 'D'], ['10', '40', '30', '20'], '100')).toEqual([
    { text: 'B', index: 1, percent: 40 }, { text: 'C', index: 2, percent: 30 }, { text: 'D', index: 3, percent: 20 },
  ]);
});
it('keeps ballot order for ties and returns zero percentages before voting', () => {
  expect(pollLeadingOptions(['Yes', 'No'], ['0', '0'], '0')).toEqual([{ text: 'Yes', index: 0, percent: 0 }, { text: 'No', index: 1, percent: 0 }]);
});
it('compares large token weights without losing integer precision', () => {
  expect(pollLeadingOptions(['A', 'B'], ['1000000000000000000', '1000000000000000001'], '2000000000000000001')[0].text).toBe('B');
});
