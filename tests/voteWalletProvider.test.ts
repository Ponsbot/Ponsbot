import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { bindVotingProvider, type VotingProvider } from '../lib/vote-wallet-provider';
const address = '0x1111111111111111111111111111111111111111';
function fixture() {
  const listeners = new Map<string, () => void>();
  const provider: VotingProvider = {
    request: vi.fn(async ({ method }) => method === 'eth_accounts' ? [address] : '0x1237'),
    on: vi.fn((event, fn) => { listeners.set(event, fn); }),
    removeListener: vi.fn((event) => { listeners.delete(event); }),
  };
  return { provider, listeners };
}
describe('restored voting provider binding', () => {
  it.each(['accountsChanged', 'chainChanged', 'disconnect'])('detects %s after restoration', async event => {
    const { provider, listeners } = fixture(), changed = vi.fn();
    const release = await bindVotingProvider(provider, address, changed);
    listeners.get(event)!(); expect(changed).toHaveBeenCalledOnce();
    release(); expect(listeners.size).toBe(0);
  });
  it('subscribes before account requests and rejects a change during validation', async () => {
    const { provider, listeners } = fixture(), changed = vi.fn();
    provider.request = vi.fn(async ({ method }) => {
      expect(listeners.size).toBe(3);
      if (method === 'eth_accounts') { listeners.get('accountsChanged')!(); return [address]; }
      return '0x1237';
    });
    await expect(bindVotingProvider(provider, address, changed)).rejects.toThrow('Wallet changed');
    expect(listeners.size).toBe(0);
  });
  it.each(['eth_accounts', 'eth_chainId'])('cleans listeners if final %s throws', async failedMethod => {
    const { provider, listeners } = fixture();
    provider.request = vi.fn(async ({ method }) => {
      if (method === failedMethod) throw new Error('Provider unavailable');
      return method === 'eth_accounts' ? [address] : '0x1237';
    });
    await expect(bindVotingProvider(provider, address, vi.fn())).rejects.toThrow('Provider unavailable');
    expect(listeners.size).toBe(0);
  });
  it.each([{ accounts: [] }, { accounts: ['0x2222222222222222222222222222222222222222'] }])('rejects stale signed identity for accounts $accounts', async ({ accounts }) => {
    const { provider } = fixture();
    provider.request = vi.fn(async ({ method }) => method === 'eth_accounts' ? accounts : '0x1237');
    await expect(bindVotingProvider(provider, address, vi.fn())).rejects.toThrow('Wallet changed');
  });
  it('refuses a provider without change events', async () => {
    await expect(bindVotingProvider({ request: vi.fn() }, address, vi.fn())).rejects.toThrow('cannot monitor');
  });
  it('guards server-session creation and cleans every failed connect', () => {
    const source = readFileSync(new URL('../components/VoteWalletConnect.tsx', import.meta.url), 'utf8');
    const connect = source.slice(source.indexOf('async function connect('), source.indexOf('async function disconnect()'));
    expect(connect.indexOf("sessionStorage.setItem(CLEANUP_KEY, '1')")).toBeLessThan(connect.indexOf("operation: 'verify'"));
    expect(connect).toMatch(/catch \(e\) \{[\s\S]*?detach\(\); apply\(\{\}\);[\s\S]*?await revoke\(\)/);
    expect(source).toContain('if (sessionStorage.getItem(CLEANUP_KEY)) { await revoke(); return; }');
  });
});
