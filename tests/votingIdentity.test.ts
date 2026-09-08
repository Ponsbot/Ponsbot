import { expect, it } from 'vitest';
import { votingIdentity } from '../lib/vote-wallet-provider';
it('does not fall back after external account change, failure or expiry', () => {
  expect(votingIdentity(null, 'pons', false, false)).toEqual({ source: 'external', address: null });
});
it.each([true, false])('locks all actions while verification is pending (Pons selected: %s)', usePons => {
  expect(votingIdentity('external', 'pons', usePons, true).address).toBeNull();
});
it('uses Pons only when deliberately selected or no external session was chosen', () => {
  expect(votingIdentity(null, 'pons', true, false)).toEqual({ source: 'pons', address: 'pons' });
  expect(votingIdentity('external', 'pons', false, false)).toEqual({ source: 'external', address: 'external' });
});
it('supports a verified external wallet without X identity', () => {
  expect(votingIdentity('external', undefined, false, false).address).toBe('external');
});
