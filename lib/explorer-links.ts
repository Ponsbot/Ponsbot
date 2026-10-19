/** Upgrade saved public explorer links without rewriting data-provider API URLs. */
export function currentExplorerLinks(text: string) {
  return text.replace(/https:\/\/robinhoodchain\.blockscout\.com\/(?:address|tx|token)\/[^\s<>"']+/gi, value => {
    const url = new URL(value);
    url.hostname = "robin.etherscan.io";
    url.pathname = url.pathname.replace(/^\/token\/([^/]+)\/instance\/(\d+)/, "/nft/$1/$2");
    if (url.searchParams.get("tab") === "txs") {
      url.searchParams.delete("tab");
      url.hash = "transactions";
    }
    return url.toString();
  });
}
