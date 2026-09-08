export type VotingProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, fn: () => void) => void;
  removeListener?: (event: string, fn: () => void) => void;
};

// Subscribe before checking the account, so a change during either RPC is not lost.
export async function bindVotingProvider(provider: VotingProvider, address: string, changed: () => void) {
  if (!provider.on || !provider.removeListener) throw new Error('This wallet cannot monitor account changes. Use another browser wallet.');
  let invalidated = false;
  const listener = () => { invalidated = true; changed(); };
  const events = ['accountsChanged', 'chainChanged', 'disconnect'];
  const release = () => events.forEach(event => provider.removeListener?.(event, listener));
  try {
    events.forEach(event => provider.on?.(event, listener));
    const accounts = await provider.request({ method: 'eth_accounts' });
    const chain = await provider.request({ method: 'eth_chainId' });
    if (invalidated || !Array.isArray(accounts) || typeof accounts[0] !== 'string'
      || accounts[0].toLowerCase() !== address.toLowerCase() || chain !== '0x1237') {
      throw new Error('Wallet changed. Connect and sign again.');
    }
    return release;
  } catch (error) { release(); throw error; }
}
