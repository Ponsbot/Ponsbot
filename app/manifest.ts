import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Pons Bot",
    short_name: "Pons Bot",
    description: "Wallet, trading, and Pons V2 launches direct on X.",
    start_url: "/",
    display: "standalone",
    background_color: "#f5f3eb",
    theme_color: "#c9ff4a",
    icons: [
      { src: "/faviconlarge.png", sizes: "192x192", type: "image/png" },
      { src: "/icon.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
