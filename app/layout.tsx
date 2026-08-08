import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ponsbot — Robinhood Chain wallet & launch bot",
  description: "Create a Robinhood Chain wallet and launch through Pons from an X reply.",
  icons: { icon: "/ponsbot.png", apple: "/ponsbot.png" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
