import { expect, it } from 'vitest';
import { parsePollMinimum, resolvePollMinimum, pollMinimumText } from '../lib/poll-minimum';
import { parsePollDraft } from '../lib/polls';
import { advancePollDraft } from '../lib/poll-workflow';
it.each(['$100', '100 USD', '100 dollars'])('accepts dollars: %s', text => {
  expect(parsePollMinimum(text).minimumHolding).toEqual({ unit: 'usd', amount: '100' });
});
it.each(['10,000 tokens', '10k tokens', '10000'])('accepts token counts: %s', text => {
  expect(parsePollMinimum(text).minimumHolding).toEqual({ unit: 'tokens', amount: '10000' });
});
it('retains percentage support', () => expect(parsePollMinimum('0.1%')).toEqual({ minimumHoldingPercent: 0.1 }));
it('converts dollars to raw token units and rounds up, not down', () => {
  expect(resolvePollMinimum({ unit: 'usd', amount: '100' }, '100000000', 2, '30000', 10)).toEqual({ balance: '333334', percent: 0.333334, marketCapUsd: '30000', pricedAt: 10 });
});
it('handles exact token counts with 18 decimals without floating point loss', () => {
  expect(resolvePollMinimum({ unit: 'tokens', amount: '10000.000000000000000001' }, '1000000000000000000000000', 18).balance).toBe('10000000000000000000001');
});
it('rejects missing prices and thresholds above supply', () => {
  expect(() => resolvePollMinimum({ unit: 'usd', amount: '100' }, '100000', 2)).toThrow();
  expect(() => resolvePollMinimum({ unit: 'tokens', amount: '1001' }, '100000', 2)).toThrow();
});
it.each(['Minimum holding: $100', 'Minimum holding: 10,000 tokens', '$100', '10,000 tokens'])('parses direct command threshold %s', minimum => {
  const d = parsePollDraft(`create a vote for $PONSBOT Should we proceed? Options: Yes, No, 1 day, ${minimum}`);
  expect(d?.durationMinutes).toBe(1440); expect(d?.options).toEqual(['Yes', 'No']);
  expect(d?.minimumHolding?.unit).toBe(minimum.includes('$') ? 'usd' : 'tokens');
});
it('guided flow accepts dollars and allows changing back to percent', () => {
  const draft = { token: 'TOKEN', question: 'Proceed?', options: ['Yes', 'No'], durationMinutes: 60, minimumHoldingPercent: 0.1 };
  const dollar = advancePollDraft(draft, 'minimum', '$100');
  expect(dollar.state).toBe('ready');
  const percent = advancePollDraft(dollar.draft, 'minimum', '0.5%');
  expect(percent.state).toBe('ready'); expect(percent.draft.minimumHolding).toBeUndefined();
});
it('displays frozen token amount', () => {
  expect(pollMinimumText(0.1, { unit: 'usd', amount: '100' }, { balance: '50000', percent: 1 }, 2, 'TOKEN')).toContain('500 TOKEN');
});
