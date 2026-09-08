'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { WEBSITE_VOTING_PUBLIC } from '@/lib/voting-access';
export function VotesNavLink({ onNavigate }: { onNavigate?: () => void }) {
  const [allowed, setAllowed] = useState(WEBSITE_VOTING_PUBLIC);
  useEffect(() => {
    if (WEBSITE_VOTING_PUBLIC) return;
    let active = true;
    fetch('/api/auth/x/session', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(s => {
      if (active) setAllowed(s?.authenticated === true && s?.votingPreviewEnabled === true);
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  return allowed ? <Link href='/votes' onClick={onNavigate}>VOTES</Link> : null;
}
