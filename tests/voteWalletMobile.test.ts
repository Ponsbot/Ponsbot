import { beforeEach, afterEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock('@walletconnect/ethereum-provider', () => ({ EthereumProvider: { init: mock.init } }));
beforeEach(() => {
  vi.resetModules(); mock.init.mockReset();
  vi.stubEnv('NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID', 'a'.repeat(32));
  vi.stubGlobal('window', { location: { origin: 'https://www.ponsbot.family' } });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function fixture() {
  const raw = { session: undefined as object | undefined, accounts: ['0x1111111111111111111111111111111111111111'], chainId: 4663, request: vi.fn(async () => 'signature'), on: vi.fn(), removeListener: vi.fn(), connect: vi.fn(async () => { raw.session = {}; }), disconnect: vi.fn(async () => { raw.session = undefined; }) };
  mock.init.mockResolvedValue(raw); return raw;
}
it('only proposes personal signing on Robinhood Chain and disables telemetry', async () => {
  fixture(); const { mobileVotingProvider } = await import('../lib/vote-wallet-mobile');
  await mobileVotingProvider();
  expect(mock.init).toHaveBeenCalledWith(expect.objectContaining({ chains: [4663], methods: ['personal_sign'], optionalMethods: [], telemetryEnabled: false, showQrModal: true }));
});
it('reuses restored pairings without opening the modal and provides local account checks', async () => {
  const raw = fixture(); raw.session = {};
  const { mobileVotingProvider } = await import('../lib/vote-wallet-mobile');
  const provider = await mobileVotingProvider(); await provider.connect();
  expect(raw.connect).not.toHaveBeenCalled();
  expect(await provider.request({ method: 'eth_chainId' })).toBe('0x1237');
  expect(await provider.request({ method: 'eth_accounts' })).toEqual(raw.accounts);
  expect(raw.request).not.toHaveBeenCalled();
  await provider.disconnect(); expect(raw.disconnect).toHaveBeenCalledOnce();
});
it('blocks transaction and approval transports while allowing the signature', async () => {
  const raw = fixture(); const { mobileVotingProvider } = await import('../lib/vote-wallet-mobile');
  const provider = await mobileVotingProvider();
  for (const method of ['eth_sendTransaction', 'eth_signTypedData_v4', 'wallet_sendCalls', 'eth_sendRawTransaction']) await expect(provider.request({ method })).rejects.toThrow('only supports');
  expect(raw.request).not.toHaveBeenCalled();
  await provider.request({ method: 'personal_sign', params: ['0x1234', raw.accounts[0]] });
  expect(raw.request).toHaveBeenCalledOnce();
});
it('does not initialize the SDK without a project ID', async () => {
  vi.stubEnv('NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID', '');
  const { mobileVotingProvider } = await import('../lib/vote-wallet-mobile');
  await expect(mobileVotingProvider()).rejects.toThrow('not configured'); expect(mock.init).not.toHaveBeenCalled();
});
