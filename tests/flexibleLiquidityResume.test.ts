import { expect, it } from 'vitest';
import { liquidityControl } from '../lib/liquidity-workflow';
it.each(['please resume', 'I funded my wallet, continue', '@Ponsbotfamily @deltaliquidity resume', 'Could you resume the setup please?'])('refreshes rather than authorizing a position for %s', text => {
  expect(liquidityControl(text, 'review')?.kind).toBe('refresh');
});
it('keeps funding recovery retry semantics', () => expect(liquidityControl('Done, try again')?.kind).toBe('retry'));
it('does not treat unrelated instructions as a saved-settings retry', () => expect(liquidityControl('resume and buy $100 of TEST')).toBeNull());
it('keeps explicit confirmation separate', () => expect(liquidityControl('confirm')?.kind).toBe('confirm'));
