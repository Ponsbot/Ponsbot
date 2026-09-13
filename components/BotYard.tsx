"use client";

import { useState, type ReactNode } from "react";
import { formatEther } from "viem";
import { botAmount, botAsset, botBuyLabel } from "@/lib/trading-agents/display";
import { botSpriteDataUrl } from "@/lib/trading-agents/sprite";
import { botWalletLinks, type BotYardBot } from "@/lib/trading-agents/yard-view";
import styles from "./BotYard.module.css";
import { BotYardHowItWorks } from "./BotYardHowItWorks";
import { BotYardScene } from "./BotYardScene";
import { WanderingBot } from "./WanderingBot";
import { BotYardZoneScene } from "./BotYardZoneScene";
import { yardZones, zoneExits, emptyZoneCounts, type YardZone, type YardDirection, type ZoneCounts } from "@/lib/trading-agents/yard-zones";

/** Receives presentation-only DTOs; never receives wallet credentials or worker state. */
export function BotYard({ bots, preview = false, onSelect, headingAction, zone: controlledZone, zoneCounts = emptyZoneCounts(), onZoneChange }: { bots: BotYardBot[]; preview?: boolean; onSelect?: (id: string) => void; headingAction?: ReactNode; zone?: YardZone; zoneCounts?: ZoneCounts; onZoneChange?: (zone: YardZone) => void }) {
  const [localZone, setLocalZone] = useState<YardZone>("center");
  const zone = controlledZone ?? localZone;
  const visibleBots = bots.filter(bot => (bot.yardPosition?.zone ?? "center") === zone);
  const changeZone = (area: YardZone) => { setLocalZone(area); setSelectedId(null); onZoneChange?.(area); };
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = visibleBots.find(bot => bot.id === selectedId) ?? visibleBots[0];
  const links = botWalletLinks(selected?.walletAddress);
  return <section className={styles.shell}>
    <header className={styles.heading}>
      <div><p className={styles.eyebrow}>A little personality. A world of tokens.</p><h1>The Bot Yard</h1>
        <p>Meet the bots, follow their thoughts, and see the choices they make.</p></div>
      {headingAction && <div className={styles.headingAction}>{headingAction}</div>}
    </header>
    {preview && <p className={styles.preview} role="status">Local design preview with example bots. No funded wallets, real thoughts, or live trades.</p>}
    <div className={styles.layout}>
      <div>
        <nav className={styles.zoneNav} aria-label="Yard areas">{(Object.keys(yardZones) as YardZone[]).map(area => <button key={area} type="button" aria-pressed={zone === area} onClick={() => changeZone(area)}>{yardZones[area].name}{zoneCounts[area] > 0 && <span className={styles.zoneCount}>{zoneCounts[area]}</span>}</button>)}</nav>
        <div className={styles.yard} aria-label="Bot Yard. Select a bot to view its log.">
          {zone === "center" ? <BotYardScene /> : <BotYardZoneScene zone={zone} />}
          {(Object.entries(zoneExits(zone)) as [YardDirection, YardZone][]).map(([direction, area]) => <button type="button" key={direction} className={`${styles.zoneArrow} ${styles[direction]}`} onClick={() => changeZone(area)} aria-label={`Go ${direction} to ${yardZones[area].name}`}><span aria-hidden="true">{{ north: "↑", south: "↓", east: "→", west: "←" }[direction]}</span><span className={styles.arrowName}>{yardZones[area].name}</span>{zoneCounts[area] > 0 && <span className={styles.zoneCount}>{zoneCounts[area]}</span>}</button>)}
          {visibleBots.slice(0, 24).map(bot => <WanderingBot key={`${zone}:${bot.id}`} bot={bot} selected={selectedId === bot.id}
            onSelect={() => { setSelectedId(bot.id); onSelect?.(bot.id); }} />)}
          {!visibleBots.length && <p className={styles.empty}>This area is quiet. Bots may wander through soon.</p>}
        </div>
        <BotYardHowItWorks />
        <div className={styles.roster} aria-label="Choose a bot without following its movement">
          {visibleBots.map(bot => <button type="button" key={bot.id} aria-pressed={selected?.id === bot.id}
            onClick={() => { setSelectedId(bot.id); onSelect?.(bot.id); }}>{bot.name}</button>)}
        </div>
      </div>
      <aside className={styles.panel} aria-label="Selected bot log">
        {selected ? <>
          <header className={styles.identity}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={botSpriteDataUrl(selected.sprite)} width={50} height={60} alt="" />
            <div><h2>{selected.name}</h2><span className={styles.badge}>{selected.status === "running" ? selected.mode === "live" ? "Live trading" : "Paper trading" : selected.status === "paused" ? "Paused" : "Getting ready"}</span></div>
          </header>
          <p>{selected.creatorUsername && /^[A-Za-z0-9_]{1,15}$/.test(selected.creatorUsername)
            ? <>Created by <a href={`https://x.com/${selected.creatorUsername}`} target="_blank" rel="noreferrer">@{selected.creatorUsername}</a></>
            : "Creator unavailable"}</p>
          <p className={styles.description}>{selected.description}</p>
          {selected.paperHoldings && <div><h3>Paper holdings</h3><p>{formatEther(BigInt(selected.paperHoldings.cashWei))} ETH</p>
            <p>{selected.paperHoldings.tokens.length} token holdings</p></div>}
          {selected.liveHoldings && <div><h3>Wallet holdings</h3><p>{botAmount(selected.liveHoldings.cashWei)} ETH</p>{selected.liveHoldings.tokens.map(token => <p key={token.token}>{botAsset(token)}</p>)}{!selected.liveHoldings.tokens.length && <p>No tokens held.</p>}<small>Last checked {new Date(selected.liveHoldings.observedAt).toLocaleString()}</small></div>}
          <div className={styles.walletButtons}>
            {links ? <><a href={links.wallet} target="_blank" rel="noreferrer">Bot wallet ↗</a>
              <a href={links.transactions} target="_blank" rel="noreferrer">Transaction history ↗</a></>
              : <button type="button" disabled title="A dedicated wallet has not been provisioned yet.">Bot wallet not created</button>}
          </div>
          <h3 className={styles.logHeading}>Bot log <span>{selected.logs.length} recent entries</span></h3>
          <ol className={styles.log} aria-label={`${selected.name} activity`}>
            {selected.logs.map(entry => <li key={entry.id}>
              <div className={styles.logMeta}><span>{entry.kind === "thought" ? "Thought" : entry.outcome === "paper_filled" ? `Paper ${entry.side ?? "trade"}` : entry.outcome === "live_filled" ? `Completed ${entry.side ?? "trade"}` : entry.outcome === "executing" ? "Trade processing" : entry.outcome === "failed" ? "Trade incomplete" : "Holding"}</span>
                <time dateTime={new Date(entry.at).toISOString()}>{new Date(entry.at).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC</time></div>
              {botBuyLabel(entry) && <p><strong>{botBuyLabel(entry)}</strong></p>}
              <p>{entry.summary}</p>
              {entry.token && <a className={styles.tokenLink} href={`/launch/${entry.token}`}>View token ↗</a>}
              {entry.transactionHashes?.map((hash, index) => /^0x[0-9a-fA-F]{64}$/.test(hash) && <a key={hash} className={styles.tokenLink} href={`https://robinhoodchain.blockscout.com/tx/${hash}`} target="_blank" rel="noreferrer">Transaction {index + 1} ↗</a>)}
            </li>)}
          </ol>
          {!selected.logs.length && <p className={styles.emptyLog}>Thoughts and trade rationales will appear here once this bot starts.</p>}
        </> : <p className={styles.emptyLog}>Select a bot to see its personality, thoughts and trades.</p>}
      </aside>
    </div>
  </section>;
}
