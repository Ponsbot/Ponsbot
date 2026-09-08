import { SiteHeader, SiteFooter } from '@/components/SiteChrome';
import { VotesClient } from '@/components/VotesClient';
export const metadata = { title: 'Voting | Pons Bot', description: 'Create token-holder polls and vote with your Pons Bot wallet.' };
export default function VotesPage() { return <main><SiteHeader /><VotesClient /><SiteFooter /></main>; }
