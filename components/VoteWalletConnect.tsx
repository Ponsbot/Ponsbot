'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isAddress, stringToHex } from 'viem';
import { parseSiweMessage } from 'viem/siwe';
import { bindVotingProvider, type VotingProvider as Provider } from '../lib/vote-wallet-provider';
const PROVIDER_KEY = 'pons-voting-provider';
const CLEANUP_KEY = 'pons-voting-cleanup-required';
const EXTERNAL_INTENT_KEY = 'pons-voting-external-selected';
type Wallet = { id: string; name: string; provider: Provider };
type Verified = { address?: string; expiresAt?: number };
export function VoteWalletConnect({ csrf, onChange, onBusyChange, disabled }: { csrf?: string; onChange: (address: string | null, allowPons?: boolean) => void; onBusyChange: (busy: boolean) => void; disabled: boolean }) {
  const [wallets, setWallets] = useState<Wallet[]>([]), [selected, setSelected] = useState('');
  const [verified, setVerified] = useState<Verified>({}), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const releaseProvider = useRef<(() => void) | null>(null);
  const pending = useRef(false);
  const generation = useRef(0);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  const apply = useCallback((value: Verified) => { setVerified(value); onChange(value.address ?? null); }, [onChange]);
  const call = useCallback(async (body: Record<string, string>) => {
    const r = await fetch('/api/votes/wallet', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pons-csrf': csrf ?? '' }, body: JSON.stringify(body) });
    const data = await r.json(); if (!r.ok) throw new Error(data.error || 'Wallet verification failed.'); return data;
  }, [csrf]);
  const detach = useCallback(() => { releaseProvider.current?.(); releaseProvider.current = null; }, []);
  const revoke = useCallback(async () => {
    sessionStorage.setItem(CLEANUP_KEY, '1');
    sessionStorage.removeItem(PROVIDER_KEY);
    await call({ operation: 'disconnect' });
    sessionStorage.removeItem(CLEANUP_KEY);
  }, [call]);
  const changed = useCallback(() => {
    generation.current++; detach(); apply({});
    // An in-flight connect owns cleanup and must keep the UI locked until done.
    if (pending.current) return;
    pending.current = true; setBusy(true);
    setError('Wallet changed. Connect and sign again.');
    void revoke().catch(() => setError('Wallet changed. Session cleanup failed. Reconnect to retry cleanup.'))
      .finally(() => { pending.current = false; setBusy(false); });
  }, [detach, apply, revoke]);
  useEffect(() => detach, [detach]);
  useEffect(() => {
    if (sessionStorage.getItem(PROVIDER_KEY) || sessionStorage.getItem(CLEANUP_KEY)) sessionStorage.setItem(EXTERNAL_INTENT_KEY, '1');
    if (!sessionStorage.getItem(PROVIDER_KEY) && !sessionStorage.getItem(CLEANUP_KEY) && !sessionStorage.getItem(EXTERNAL_INTENT_KEY)) onChange(null, true);
  }, [onChange]);
  useEffect(() => {
    // Wallet-supplied names are text only. Never execute or embed provider icons.
    const announce = (event: Event) => {
      const d = (event as CustomEvent).detail;
      if (!d || typeof d.info?.uuid !== 'string' || typeof d.info?.name !== 'string' || typeof d.provider?.request !== 'function') return;
      setWallets(old => old.some(x => x.provider === d.provider) || old.length >= 20 ? old : [...old, { id: typeof d.info.rdns === 'string' ? d.info.rdns.slice(0, 100) : d.info.uuid.slice(0, 100), name: d.info.name.slice(0, 80), provider: d.provider }]);
    };
    window.addEventListener('eip6963:announceProvider', announce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    const fallback = (window as Window & { ethereum?: Provider }).ethereum;
    if (fallback?.request) setWallets(old => old.some(x => x.provider === fallback) ? old : [...old, { id: 'injected', name: 'Browser wallet', provider: fallback }]);
    return () => window.removeEventListener('eip6963:announceProvider', announce);
  }, []);
  useEffect(() => {
    // Never expose a restored identity until its original provider is monitored
    // and its current account/chain have been checked without prompting.
    let live = true;
    const version = generation.current;
    let timer: ReturnType<typeof setTimeout>;
    const restore = () => { void (async () => {
      if (!csrf || !live || releaseProvider.current) return;
      if (pending.current) { timer = setTimeout(restore, 250); return; }
      const matches = wallets.filter(w => w.id === sessionStorage.getItem(PROVIDER_KEY));
      // Provider discovery may be delayed. Do not revoke a valid session just
      // because its extension has not announced itself yet; retry on discovery.
      if (!sessionStorage.getItem(CLEANUP_KEY) && matches.length !== 1) return;
      pending.current = true; setBusy(true);
      const current = () => live && generation.current === version;
      try {
        if (sessionStorage.getItem(CLEANUP_KEY)) { await revoke(); return; }
        const r = await fetch('/api/votes/wallet', { cache: 'no-store' });
        if (!r.ok) return;
        const d = await r.json();
        if (!current() || !d.address) return;
        const release = await bindVotingProvider(matches[0].provider, d.address, changed);
        if (!current()) {
          release();
          if (generation.current !== version) await revoke();
          return;
        }
        releaseProvider.current = release; apply(d);
      } catch (e) {
        if (live) { apply({}); setError(e instanceof Error ? e.message : 'Reconnect your voting wallet.'); }
        try { await revoke(); } catch { setError('Session cleanup failed. Reconnect to retry cleanup.'); }
      } finally {
        pending.current = false; setBusy(false);
      }
    })(); };
    timer = setTimeout(restore, 0);
    return () => { live = false; clearTimeout(timer); };
  }, [csrf, apply, wallets, changed, revoke]);
  useEffect(() => {
    if (!verified.expiresAt) return;
    const timer = setTimeout(() => { changed(); setError('Your verification expired. Connect and sign again.'); }, Math.max(0, verified.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [verified.expiresAt, changed]);
  async function connect() {
    if (pending.current || disabled || !csrf) return;
    const wallet = wallets.find(x => x.id === selected) ?? wallets[0];
    if (!wallet) { setError('Open this page in your wallet app’s browser, or install a browser wallet extension, then connect.'); return; }
    sessionStorage.setItem(EXTERNAL_INTENT_KEY, '1');
    pending.current = true; setBusy(true); setError(''); detach(); apply({});
    const attempt = ++generation.current;
    try {
      await revoke();
      if (!wallet) throw new Error('Choose a wallet to continue.');
      const provider = wallet.provider;
      const accounts = await provider.request({ method: 'eth_requestAccounts' });
      const address = Array.isArray(accounts) ? accounts[0] : undefined;
      if (typeof address !== 'string' || !isAddress(address, { strict: false })) throw new Error('No wallet account selected.');
      if (await provider.request({ method: 'eth_chainId' }) !== '0x1237') {
        try { await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1237' }] }); }
        catch { throw new Error('Select Robinhood Chain (4663) in your wallet, then connect again.'); }
      }
      const challenge = await call({ operation: 'challenge', address });
      const parsed = parseSiweMessage(challenge.message);
      if (parsed.domain !== window.location.host || parsed.uri !== `${window.location.origin}/votes` || parsed.chainId !== 4663 || parsed.address?.toLowerCase() !== address.toLowerCase() || parsed.nonce !== challenge.nonce) throw new Error('Sign-in details did not match this page.');
      const signature = await provider.request({ method: 'personal_sign', params: [stringToHex(challenge.message), address] });
      const current = await provider.request({ method: 'eth_accounts' });
      if (attempt !== generation.current || !Array.isArray(current) || current[0]?.toLowerCase() !== address.toLowerCase() || await provider.request({ method: 'eth_chainId' }) !== '0x1237') throw new Error('Wallet changed while signing. Please reconnect.');
      if (typeof signature !== 'string') throw new Error('No signature returned.');
      // Also covers an uncertain verify response or reload during final checks.
      sessionStorage.setItem(CLEANUP_KEY, '1');
      const result = await call({ operation: 'verify', nonce: challenge.nonce, signature });
      const release = await bindVotingProvider(provider, address, changed);
      if (attempt !== generation.current) { release(); throw new Error('Wallet changed while verifying. Please reconnect.'); }
      releaseProvider.current = release;
      sessionStorage.setItem(PROVIDER_KEY, wallet.id);
      sessionStorage.removeItem(CLEANUP_KEY);
      apply(result);
    } catch (e) {
      detach(); apply({});
      setError(e instanceof Error && !('code' in e) ? e.message : 'Signing was cancelled or unavailable. No transaction was submitted.');
      try { await revoke(); } catch { setError('Verification failed and session cleanup could not finish. Reconnect to retry cleanup.'); }
    }
    finally { pending.current = false; setBusy(false); }
  }
  async function disconnect() {
    if (pending.current) return;
    pending.current = true; setBusy(true); generation.current++;
    detach(); apply({});
    try { await revoke(); sessionStorage.removeItem(EXTERNAL_INTENT_KEY); onChange(null, true); setError(''); } catch { setError('Could not finish disconnecting. Reconnect to retry cleanup.'); }
    finally { pending.current = false; setBusy(false); }
  }
  return <div>
    {!verified.address && wallets.length > 1 && <label>Wallet <select value={selected || wallets[0]?.id} disabled={busy || disabled} onChange={e => setSelected(e.target.value)}>{wallets.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>}
    <button disabled={busy || disabled || !csrf} onClick={() => { void (verified.address ? disconnect() : connect()); }}>{busy ? 'Verifying…' : verified.address ? 'Disconnect' : 'Connect external wallet'}</button>
    {verified.address && <p>Verified voting wallet: <strong title={verified.address}>{verified.address.slice(0, 6)}…{verified.address.slice(-4)}</strong></p>}
    {!verified.address && error && <button disabled={busy || disabled || !csrf} onClick={() => void disconnect()}>Disconnect external wallet</button>}
    <p><small>Sign-in only. No gas, token approvals, or transactions.</small></p>
    {error && <p role='alert'>{error}</p>}
  </div>;
}
