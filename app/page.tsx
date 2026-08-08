import Image from "next/image";

const commands = [
  ["wallet", "Reply “wallet” to create or reveal your Robinhood Chain wallet."],
  ["balance", "Check ETH and supported token balances."],
  ["launch", "Send a name, ticker, artwork, links, pair asset, and optional initial buy."],
];

export default function Home() {
  return (
    <main>
      <nav className="nav">
        <a className="brand" href="#top" aria-label="Ponsbot home"><span>p</span> ponsbot</a>
        <div className="nav-links">
          <a href="#how">how it works</a>
          <a href="https://ponsfamily.com" target="_blank" rel="noreferrer">pons ↗</a>
          <span className="status"><i /> test preview</span>
        </div>
      </nav>

      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="kicker">robinhood chain · x replies · powered by pons</p>
          <h1>Your wallet.<br /><em>Your launch.</em><br />One reply away.</h1>
          <p className="lede">A focused X bot that creates Robinhood Chain wallets and launches tokens through Pons, without dashboards, detours, or extra accounts.</p>
          <div className="actions">
            <span className="primary disabled" aria-disabled="true">X bot coming soon</span>
            <a className="secondary" href="#how">see the flow ↓</a>
          </div>
          <p className="notice">Testing environment only. Wallet execution remains disabled while the signer and Pons V2 policy are completed.</p>
        </div>
        <div className="hero-art" aria-label="Ponsbot character artwork">
          <div className="orbit orbit-one" /><div className="orbit orbit-two" />
          <div className="chain-pill">chain id <strong>4663</strong></div>
          <Image src="/ponsbot.png" alt="Ponsbot" width={720} height={720} priority />
          <div className="reply-card"><span>@ponsbot</span><strong>launch Garden, ticker GDN</strong><small>↳ wallet ready · preparing launch</small></div>
        </div>
      </section>

      <section className="flow" id="how">
        <p className="kicker">built for conversation</p>
        <h2>From reply to onchain.</h2>
        <div className="command-grid">
          {commands.map(([title, body], index) => <article key={title}><span>0{index + 1}</span><h3>{title}</h3><p>{body}</p></article>)}
        </div>
      </section>

      <section className="protocol">
        <div><p className="kicker">launch rail</p><h2>Pons V2, end to end.</h2></div>
        <p>A launch begins on a bonding curve and graduates automatically into a permanently locked Uniswap V4 pool. An optional initial buy can execute atomically with the launch.</p>
        <dl><div><dt>network</dt><dd>Robinhood Chain</dd></div><div><dt>factory</dt><dd>0x7eD5…EC7e</dd></div><div><dt>state</dt><dd>testing</dd></div></dl>
      </section>

      <footer><span>ponsbot / test build</span><span>independent interface · not operated by Pons or Robinhood</span></footer>
    </main>
  );
}
