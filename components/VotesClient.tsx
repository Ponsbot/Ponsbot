'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { FunctionReturnType } from 'convex/server';
import { internal } from '@/convex/_generated/api';
import { formatUnits } from 'viem';
import { pollPercent, type PollSpec } from '@/lib/polls';
import styles from '@/app/votes/votes.module.css';
import { VoteWalletConnect } from './VoteWalletConnect';
type Poll = NonNullable<FunctionReturnType<typeof internal.polls.get>>;
type Auth = { authenticated: boolean; csrfToken?: string; walletAddress?: string; username?: string };
const amount = (raw: string, decimals: number) => Number(formatUnits(BigInt(raw), decimals)).toLocaleString('en-US', { maximumFractionDigits: 2 });
const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;
export function VotesClient({ code }: { code?: string }) {
  const [auth, setAuth] = useState<Auth>({ authenticated: false });
  const [votingWallet, setVotingWallet] = useState<string | null>(null);
  const [poll, setPoll] = useState<Poll | null>(null), [items, setItems] = useState<Poll[]>([]), [closed, setClosed] = useState(false), [next, setNext] = useState<number | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [loadError, setLoadError] = useState('');
  const [token, setToken] = useState(''), [question, setQuestion] = useState(''), [options, setOptions] = useState('Yes\nNo'), [hours, setHours] = useState('24'), [minimum, setMinimum] = useState('0.1');
  const [choice, setChoice] = useState(''), [ca, setCa] = useState('');
  const [creating, setCreating] = useState(false);
  const request = useRef<{ payload: string; id: string } | null>(null);
  const activeLoad = useRef(0);
  const expandedList = useRef(false);
  const load = useCallback(async (cursor?: number) => {
    const sequence = ++activeLoad.current;
    try {
      const r = await fetch(`/api/votes?${code ? `code=${encodeURIComponent(code)}` : `closed=${closed}${cursor ? `&cursor=${cursor}` : ''}`}`, { cache: 'no-store' });
      const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Could not load polls.');
      if (sequence !== activeLoad.current) return;
      if (code) setPoll(d.poll); else { if (cursor) expandedList.current = true; setItems(old => cursor ? [...old, ...d.items] : d.items); setNext(d.next); }
      setLoadError('');
    } catch (e) { if (sequence === activeLoad.current) setLoadError(e instanceof Error ? e.message : 'Could not load polls.'); }
  }, [code, closed]);
  useEffect(() => {
    const loadState = activeLoad;
    expandedList.current = false;
    void load(); const until = Date.now() + 300000;
    const timer = setInterval(() => { if (!document.hidden && !expandedList.current && Date.now() < until) void load(); }, 15000);
    return () => { clearInterval(timer); loadState.current++; };
  }, [load]);
  useEffect(() => { let live = true; fetch('/api/auth/x/session', { cache: 'no-store' }).then(r => r.json()).then(d => { if (live) setAuth(d); }).catch(() => {}); return () => { live = false; }; }, []);
  async function act(operation: 'create' | 'vote' | 'endorse' | 'correct', spec?: PollSpec) {
    if (busy) return;
    if (!votingWallet) { setMessage('Connect Wallet and sign to verify it before continuing.'); return; }
    setBusy(true); setMessage('');
    const payload = JSON.stringify({ operation, code, expectedWallet: votingWallet, ...(spec ? { spec } : {}), ...(operation === 'vote' ? { choice } : operation === 'correct' ? { choice: ca } : {}) });
    if (request.current?.payload !== payload) request.current = { payload, id: crypto.randomUUID() };
    try {
      const r = await fetch('/api/votes', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pons-csrf': auth.csrfToken ?? '' }, body: JSON.stringify({ ...JSON.parse(payload), eventId: request.current.id }) });
      const d = await r.json(); setMessage(d.message || d.error || 'The request could not be completed.');
      if (d.ok) { request.current = null; if (operation === 'create' && d.code) { window.location.assign(`/votes/${d.code}`); return; } await load(); }
    } catch { setMessage('The response did not arrive. Retry to check the same request without duplicating it.'); }
    finally { setBusy(false); }
  }
  const signIn = `/api/auth/x/start?returnTo=${encodeURIComponent(code ? `/votes/${code}` : '/votes')}`;
  const largestTotal = poll?.totals.reduce((n, x) => BigInt(x) > n ? BigInt(x) : n, 0n) ?? 0n;
  const winners = poll?.options.filter((_, i) => BigInt(poll.totals[i]) === largestTotal) ?? [];
  const signInNotice = <div className={styles.notice}>{!auth.authenticated && <p><a href={signIn}>Sign in with X</a> to access the voting preview.</p>}<VoteWalletConnect csrf={auth.csrfToken} onChange={setVotingWallet} disabled={busy} /></div>;
  return <section className={styles.page}>
    <header className={styles.heading}><div><Link href='/votes'>Community voting</Link><h1>{code ? 'Token-holder vote' : 'Pons Bot Voting'}</h1><p>Create a poll, give holders a voice, and follow the results.</p></div>{!code && <button onClick={() => setCreating(x => !x)}>{creating ? 'Browse polls' : 'Create a vote'}</button>}</header>
    {signInNotice}
    {loadError && <p role='alert' className={styles.notice}>{loadError} <button onClick={() => void load()}>Retry</button></p>}
    {message && <p role='status' className={styles.message}>{message}</p>}
    {!code && creating && <form className={styles.form} onSubmit={e => { e.preventDefault(); void act('create', { token, question, options: options.split('\n').map(x => x.trim()).filter(Boolean), durationMinutes: Number(hours) * 60, minimumHoldingPercent: Number(minimum) }); }}>
      <h2>Create a vote</h2><p>Anyone can create a Community poll. A verified token launcher or fee-rights holder creates an Official poll. Polls are advisory and never move funds.</p>
      <label>Token ticker, contract, or both<input required maxLength={160} value={token} onChange={e => setToken(e.target.value)} placeholder='$PONSBOT or 0x…' /></label>
      <label>Question<textarea required maxLength={400} value={question} onChange={e => setQuestion(e.target.value)} /></label>
      <label>Options, one per line (2–8)<textarea required value={options} maxLength={648} onChange={e => setOptions(e.target.value)} rows={4} /></label>
      <div className={styles.fields}><label>Duration in hours (1–168)<input type='number' required min={1} max={168} step={0.5} value={hours} onChange={e => setHours(e.target.value)} /></label><label>Minimum holding, % of total supply<input type='number' required min={0} max={100} step={0.000001} value={minimum} onChange={e => setMinimum(e.target.value)} /></label></div>
      <p>0% allows any positive directly held balance. Voting power is fixed at the snapshot. Liquidity, locker, and burn exclusions are listed on the finished poll.</p>
      <button disabled={busy || !votingWallet}>{busy ? 'Preparing…' : 'Create vote'}</button>
    </form>}
    {!code && !creating && <><div className={styles.tabs}><button aria-pressed={!closed} onClick={() => setClosed(false)}>Ongoing</button><button aria-pressed={closed} onClick={() => setClosed(true)}>Completed</button></div><div className={styles.grid}>
      {items.map(p => <Link href={`/votes/${p.code}`} key={p.code} className={styles.card}><div className={styles.badges}><span>{p.official ? 'Official' : 'Community'}</span><span>${p.snapshot?.symbol}</span></div><h2>{p.question}</h2><p>{p.voterCount} wallets · {p.turnout.toFixed(2)}% participation</p><p>{p.endsAt ? new Date(p.endsAt).toLocaleString() : ''}</p></Link>)}
    </div>{!items.length && !loadError && <p>No {closed ? 'completed' : 'ongoing'} polls yet.</p>}{next && <button onClick={() => void load(next)}>More polls</button>}</>}
    {code && poll && <article className={styles.detail}>
      <div className={styles.badges}><span>{poll.official ? 'Official' : 'Community'}</span><span>{poll.status}</span><span>{poll.code}</span></div>
      <h2>{poll.question}</h2><p>{poll.tokenAddress && <><strong>${poll.snapshot?.symbol ?? 'TOKEN'}</strong> · <a href={`https://robinhoodchain.blockscout.com/token/${poll.tokenAddress}`} target='_blank' rel='noreferrer'>{short(poll.tokenAddress)}</a></>}</p>
      <p>Created by: <span title={poll.creatorWallet}>{poll.creatorXUsername ? `@${poll.creatorXUsername}` : short(poll.creatorWallet)}</span></p>
      {poll.status === 'preparing' && <p role='status'>Preparing and verifying the fixed-block holder snapshot… This page updates automatically.</p>}
      {poll.status === 'failed' && <p>The snapshot could not be verified. Voting was not opened. Please create a new poll.</p>}
      {poll.status === 'needs_token' && <form onSubmit={e => { e.preventDefault(); void act('correct'); }}><p>Double-check the ticker and supply its matching contract address to continue.</p><label>Contract address<input value={ca} onChange={e => setCa(e.target.value)} pattern='0x[a-fA-F0-9]{40}' required /></label><button disabled={busy || !votingWallet || votingWallet.toLowerCase() !== poll.creatorWallet}>Continue</button></form>}
      {poll.snapshot && <>
        <p>{poll.status === 'closed' ? 'Closed' : 'Closes'}: {poll.endsAt && new Date(poll.endsAt).toLocaleString()}</p>
        {poll.status === 'closed' && <p className={styles.notice}>{largestTotal === 0n ? 'No votes were cast.' : `${winners.length > 1 ? 'Tie' : 'Winning option'}: ${winners.join(', ')}`}</p>}
        <div className={styles.stats}><div><small>Active voting supply</small><strong>{amount(poll.snapshot.activeSupply, poll.snapshot.decimals)}</strong></div><div><small>Tokens voted</small><strong>{amount(poll.votedWeight, poll.snapshot.decimals)}</strong></div><div><small>Participation</small><strong>{poll.turnout.toFixed(2)}%</strong></div><div><small>Voting wallets</small><strong>{poll.voterCount}</strong></div></div>
        <div className={styles.options}>{poll.options.map((o, i) => <label key={i} className={styles.option}>
          <span>{poll.status === 'open' && <input type='radio' name='vote' value={i + 1} checked={choice === String(i + 1)} onChange={e => setChoice(e.target.value)} disabled={busy} />}{i + 1}. {o}</span>
          <strong>{pollPercent(poll.totals[i], poll.votedWeight).toFixed(2)}%</strong><progress value={pollPercent(poll.totals[i], poll.votedWeight)} max={100} /><small>{amount(poll.totals[i], poll.snapshot!.decimals)} tokens</small>
        </label>)}</div>
        {poll.status === 'open' && <button disabled={busy || !choice || !votingWallet} onClick={() => void act('vote')}>{busy ? 'Checking…' : 'Cast / update vote'}</button>}
        <p>Your latest vote replaces your earlier choice. No gas or token approval is required. Minimum holding: {poll.minimumHoldingPercent}% of total supply at the snapshot{poll.minimumHoldingPercent === 0 ? ' (positive balance required)' : ''}.</p>
        <details><summary>Snapshot and voting rules</summary><p>Block {poll.snapshot.block} · {new Date(poll.snapshot.timestamp).toLocaleString()}</p><p>{poll.snapshot.policy}</p><p>Total supply: {amount(poll.snapshot.supply, poll.snapshot.decimals)}. Turnout is measured against active voting supply, which can include holders below the minimum threshold.</p><ul>{poll.snapshot.exclusions.map(x => <li key={x.address}>{x.label} ({short(x.address)}): {amount(x.balance, poll.snapshot!.decimals)}</li>)}</ul></details>
        {poll.official && <p>Official endorsement verified for {short(poll.officialBy ?? poll.creatorWallet)}{poll.officialAt ? ` on ${new Date(poll.officialAt).toLocaleString()}` : ''}. This is not a binding governance action.</p>}
        {!poll.official && poll.status === 'open' && <div className={styles.notice}><p>The launcher or current fee-rights holder can endorse this Community poll without changing existing votes.</p><button disabled={busy || !votingWallet} onClick={() => void act('endorse')}>Verify rights and make Official</button></div>}
        {poll.xPostId && <p><a href={`https://x.com/Ponsbotfamily/status/${poll.xPostId}`} target='_blank' rel='noreferrer'>View the X voting post</a></p>}
      </>}
    </article>}
  </section>;
}
