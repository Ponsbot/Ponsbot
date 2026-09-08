import { expect, it } from 'vitest';
import { groundedCanonicalCommand } from '../convex/xWalletIntent';
import { extractGroundedLaunchName, parseWalletCommand } from '../convex/walletCommands';

it.each([
  '@Ponsbotfamily launch token Hermes name ticker Herman @Ponsbotfamily',
  'launch token Hermes name ticker Herman',
  'launch token name Hermes ticker Herman @Ponsbotfamily',
  'launch token Hermes name: ticker: Herman',
  'launch coin Hermes name symbol Herman',
])('grounds the correct identity for %s', text => {
  expect(extractGroundedLaunchName(text)).toBe('Hermes');
  expect(parseWalletCommand(text)).toMatchObject({ kind: 'launch', name: 'Hermes', symbol: 'HERMAN' });
  expect(groundedCanonicalCommand(text)).toMatchObject({ kind: 'launch', name: 'Hermes', symbol: 'HERMAN' });
});

it('preserves multiword values', () => {
  expect(groundedCanonicalCommand('launch token Hermes Club name ticker HERMAN')).toMatchObject({ name: 'Hermes Club', symbol: 'HERMAN' });
});
it('does not derive a ticker when a trailing ticker label is unfinished', () => {
  expect(groundedCanonicalCommand('launch Secret Name ticker')).toBeNull();
});
it('does not strip Name from explicitly quoted names', () => {
  expect(groundedCanonicalCommand('launch "My Name" ticker NAME')).toMatchObject({ name: 'My Name', symbol: 'NAME' });
});
it('keeps fee recipients and developer buys unchanged', () => {
  expect(groundedCanonicalCommand('launch token Hermes name ticker Herman assign fees to @Ponsbotfamily buy $20')).toMatchObject({ name: 'Hermes', symbol: 'HERMAN', devBuy: { amount: '20', unit: 'usd' } });
});
