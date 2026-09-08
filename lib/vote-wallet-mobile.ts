import type { VotingProvider } from './vote-wallet-provider';

export const MOBILE_VOTING_PROVIDER_ID = 'pons-walletconnect';
export type MobileVotingProvider = VotingProvider & { connect: () => Promise<void>; disconnect: () => Promise<void> };
let instance: Promise<MobileVotingProvider> | undefined;

// Lazy loaded: visiting other pages never initializes the relay or wallet UI.
export function mobileVotingProvider(): Promise<MobileVotingProvider> {
  if (instance) return instance;
  instance = (async (): Promise<MobileVotingProvider> => {
    const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
    if (!projectId || !/^[a-f0-9]{32}$/i.test(projectId)) throw new Error('Mobile wallet connections are not configured yet.');
    const { EthereumProvider } = await import('@walletconnect/ethereum-provider');
    const provider = await EthereumProvider.init({
      projectId,
      chains: [4663],
      methods: ['personal_sign'],
      optionalMethods: [],
      events: ['accountsChanged', 'chainChanged'],
      optionalEvents: [],
      rpcMap: { 4663: 'https://rpc.mainnet.chain.robinhood.com' },
      showQrModal: true,
      telemetryEnabled: false,
      metadata: { name: 'Pons Bot Voting', description: 'Sign in to token-gated voting. No transactions or token approvals.', url: window.location.origin, icons: [] },
    });
    return {
      connect: async () => { if (!provider.session) await provider.connect(); },
      disconnect: async () => { if (provider.session) await provider.disconnect(); },
      request: async ({ method, params }) => {
        // Do not let this connector become a transaction-signing transport.
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return provider.accounts;
        if (method === 'eth_chainId') return `0x${provider.chainId.toString(16)}`;
        if (method !== 'personal_sign') throw new Error('This connection only supports voting sign-in.');
        return provider.request({ method, params });
      },
      on: (event, listener) => {
        if (event === 'accountsChanged' || event === 'chainChanged' || event === 'disconnect') provider.on(event, listener);
      },
      removeListener: (event, listener) => {
        if (event === 'accountsChanged' || event === 'chainChanged' || event === 'disconnect') provider.removeListener(event, listener);
      },
    };
  })().catch(error => { instance = undefined; throw error; });
  return instance;
}
