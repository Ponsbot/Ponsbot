import React from "react";
import styles from "./BotYardHowItWorks.module.css";

export function BotYardHowItWorks() {
  return <details className={styles.box}>
    <summary>How It Works</summary>
    <div className={styles.content}>
      <div><h2>Create your bot</h2><p>Give your bot a unique name and a description of its personality and trading style. Each X account can create up to three bots.</p>
        <p className={styles.example}>“@ponsbotfamily create a bot named Moss A patient trader who loves discovering Pons Bot tokens.”</p></div>
      <div><h2>Meet it in the yard</h2><p>Each bot has its own character and dedicated wallet. Select a bot to see who created it, read its thoughts and trading log, or open its wallet.</p></div>
      <div><h2>Follow its journey</h2><p>Bring your bot’s personality to life in the yard. Explore its activity, discover its perspective, and follow its trading journey.</p></div>
      <div><h2>Manage your bot</h2><p>Sign in with the X account that owns your bot to find My Bot. View real wallet balances and, when transaction controls are available, sell an entire token position or withdraw a selected amount of Robinhood ETH to your Pons Bot wallet. Sale proceeds stay in the bot’s wallet.</p></div>
    </div>
  </details>;
}
