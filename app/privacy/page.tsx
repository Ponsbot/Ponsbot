import type { Metadata } from "next";
import { LegalDocument, type LegalSection } from "@/components/LegalDocument";

export const metadata: Metadata = { title: "Privacy Policy", description: "How Pons Bot collects, uses, shares, and protects information.", alternates: { canonical: "/privacy" } };

const sections: LegalSection[] = [
  { title: "About this policy", paragraphs: ["This Privacy Policy explains how Pons Bot collects, uses, shares, and protects information when you visit ponsbot.family, connect an X account, use a Pons Bot wallet, submit commands, or otherwise use our services.", "Questions or privacy requests may be sent to ponsbot@ponsbot.family."] },
  { title: "Information we collect", bullets: ["X account information needed to authenticate you, receive commands, and provide responses.", "Public wallet and blockchain information, including addresses, balances, transaction hashes, token activity, launches, fee activity, and liquidity positions.", "Content you provide, including X posts, terminal requests, token details, images, links, wallet destinations, and support messages."] },
  { title: "How we use information", bullets: ["Provide wallets and carry out the actions you request.", "Display wallet, token, launch, transaction, fee, and liquidity information.", "Authenticate sessions, prevent abuse, secure the service, diagnose failures, and improve reliability.", "Respond to support requests and comply with legal obligations."] },
  { title: "Public blockchain information", paragraphs: ["Blockchain networks are public. Wallet addresses, transactions, token activity, smart-contract interactions, and related records may remain permanently visible through block explorers, nodes, indexers, and other independent services. Pons Bot cannot alter or delete information recorded on a public blockchain."] },
  { title: "How information is shared", paragraphs: ["Pons Bot does not sell personal information. Information may be provided to infrastructure and service providers where needed to operate the service, process your instructions, prevent abuse, or comply with law."], bullets: ["X and authentication providers.", "Wallet infrastructure, blockchain networks, RPC providers, smart contracts, and block explorers.", "Hosting, database, security, analytics, AI, market-data, cross-chain swap, and liquidity providers."] },
  { title: "Third-party services", paragraphs: ["Features may interact with independent services such as X, Coinbase Developer Platform, Pons, Houdini Swap, Delta Liquidity, Robinhood Chain, CoinGecko, GeckoTerminal, Blockscout, and other wallet, market-data, or blockchain providers. Their own terms and privacy practices apply to information they process."] },
];

export default function PrivacyPage() { return <LegalDocument eyebrow="Pons Bot legal" title="Privacy Policy" summary="How Pons Bot handles information across its website, X features, wallets, and related services." sections={sections} />; }
