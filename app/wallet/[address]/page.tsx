import type { Metadata } from "next";
import { isAddress } from "viem";
import { notFound } from "next/navigation";
import Link from "next/link";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { ExternalTokenImage } from "@/components/ExternalTokenImage";
import { CopyAddress } from "@/components/CopyAddress";
import { CopyWalletAddress } from "@/components/CopyWalletAddress";
import { WalletTerminalLink } from "@/components/WalletTerminalLink";
import { WalletHoldingsLoading } from "@/components/WalletHoldingsLoading";
import {
  explorerAddress,
  explorerToken,
  getPonsbotWallet,
  getWalletHoldings,
  shortAddress,
} from "@/lib/site-data";

type Props = { params: Promise<{ address: string }> };
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const address = (await params).address;
  const valid = isAddress(address);
  const title = valid ? `${shortAddress(address)} wallet` : "Wallet";
  const description = valid
    ? `View the public Robinhood Chain holdings for the Pons Bot wallet ${shortAddress(address)}.`
    : "This is not a valid Pons Bot wallet.";
  return {
    title,
    description,
    ...(valid
      ? {
          alternates: { canonical: `/wallet/${address}` },
          openGraph: {
            title,
            description,
            url: `/wallet/${address}`,
            type: "website" as const,
            images: [
              {
                url: "/ponsbot-banner.png",
                width: 2172,
                height: 724,
                alt: "Pons Bot - wallet, trading, and Pons V2 launches on X",
              },
            ],
          },
          twitter: {
            card: "summary_large_image" as const,
            title,
            description,
            images: ["/ponsbot-banner.png"],
          },
        }
      : {}),
  };
}

export default async function WalletPage({ params }: Props) {
  const address = (await params).address;
  if (!isAddress(address)) notFound();
  let walletRecord: Awaited<ReturnType<typeof getPonsbotWallet>>;
  try {
    walletRecord = await getPonsbotWallet(address);
  } catch {
    return <WalletPageShell address={address}><WalletHoldingsLoading message="Wallet data is taking a moment to load" /></WalletPageShell>;
  }
  if (!walletRecord) notFound();
  let walletData: Awaited<ReturnType<typeof getWalletHoldings>>;
  try {
    walletData = await getWalletHoldings(address, walletRecord);
  } catch {
    return <WalletPageShell address={address}><WalletHoldingsLoading /></WalletPageShell>;
  }
  const { holdings, available, username } = walletData;
  return (
    <main>
      <SiteHeader />
      <section className="detail-shell">
        <div className="wallet-heading">
          <div>
            <h1>Wallet Holdings</h1>
            {username ? <a className="wallet-x-link" href={`https://x.com/${username.replace(/^@/, "")}`} target="_blank" rel="noreferrer">@{username.replace(/^@/, "")}</a> : null}
          </div>
          <div className="wallet-heading-actions"><WalletTerminalLink address={address} /><a
            className="button button-quiet"
            href={explorerAddress(address)}
            target="_blank"
            rel="noreferrer"
          >
            View on Blockscout ↗
          </a></div>
        </div>
        <CopyWalletAddress address={address} />
        <div className="holdings">
          {holdings.map((holding) => {
            const href = holding.address && holding.isPonsbotLaunch ? `/launch/${holding.address}` : holding.address ? explorerToken(holding.address) : explorerAddress(address);
            const external = !holding.isPonsbotLaunch;
            return <article className="holding" key={`${holding.address || "eth"}-${holding.symbol}`}>
              <Link className="holding-main" href={href} {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>
              <span className={`holding-icon${holding.symbol === "ETH" ? " holding-icon-eth" : ""}${holding.isPairAsset ? " holding-icon-pair" : ""}`}>
                {holding.iconUrl ? (
                  <ExternalTokenImage
                    src={holding.iconUrl}
                    name={holding.name}
                  />
                ) : (
                  holding.symbol.slice(0, 1)
                )}
              </span>
              <span>
                <h3>{holding.name}</h3>
                <p>{holding.symbol}</p>
              </span>
              </Link>
              {holding.address ? <CopyAddress address={holding.address} displayAddress={shortAddress(holding.address)} compact /> : null}
              <strong className="holding-balance">
                {holding.balance} {holding.symbol}{holding.usdValue !== undefined ? <small> ({formatUsd(holding.usdValue)})</small> : null}
              </strong>
            </article>;
          })}
        </div>
        {!holdings.length ? available ? (
          <div className="subtle-panel">
            <h3>
              No holdings yet
            </h3>
            <p>
              Send Robinhood Chain ETH or supported tokens to this wallet and they will appear here.
            </p>
          </div>
        ) : <WalletHoldingsLoading /> : null}
      </section>
      <SiteFooter />
    </main>
  );
}

function WalletPageShell({ address, children }: { address: string; children: React.ReactNode }) {
  return (
    <main>
      <SiteHeader />
      <section className="detail-shell">
        <div className="wallet-heading">
          <div><h1>Wallet Holdings</h1></div>
          <div className="wallet-heading-actions">
            <a className="button button-quiet" href={explorerAddress(address)} target="_blank" rel="noreferrer">View on Blockscout ↗</a>
          </div>
        </div>
        <CopyWalletAddress address={address} />
        {children}
      </section>
      <SiteFooter />
    </main>
  );
}

function formatUsd(value: number) {
  if (value > 0 && value < 0.01) return "<$0.01";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}
