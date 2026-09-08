import { SiteHeader, SiteFooter } from '@/components/SiteChrome';
import { VotesClient } from '@/components/VotesClient';
import { notFound } from 'next/navigation';
export const metadata = { title: 'Token-holder vote | Pons Bot' };
export default async function VotePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params; if (!/^POLL-[a-f0-9]{16}$/i.test(code)) notFound();
  return <main><SiteHeader /><VotesClient code={code.toUpperCase()} /><SiteFooter /></main>;
}
