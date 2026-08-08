import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Ponsbot", template: "%s · Ponsbot" },
  description: "Create a Robinhood Chain wallet, view holdings, and launch on Pons V2 through X replies.",
  icons: { icon: "/ponsbot.png", apple: "/ponsbot.png" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
