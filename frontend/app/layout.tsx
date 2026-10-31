import type { Metadata } from "next";
import { Inter, Pixelify_Sans } from "next/font/google";
import Link from "next/link";
import { Providers } from "./providers";
import { GatewayStatus } from "@/components/GatewayStatus";
import { Mascot } from "@/components/Mascot";
import "./globals.css";

const body = Inter({ subsets: ["latin"], variable: "--font-body", display: "swap" });
const display = Pixelify_Sans({ subsets: ["latin"], variable: "--font-display", display: "swap" });

export const metadata: Metadata = {
  title: "Invoice Scam Sniffer",
  description: "E-Rechnungen mit Cardano-Zahlungsadresse prüfen lassen, bezahlt per x402 auf Cardano Preprod.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de" className={`${body.variable} ${display.variable}`}>
      <body className="min-h-screen">
        <Providers>
          <header className="border-b border-line bg-surface/80 backdrop-blur">
            <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
              <Link href="/" className="flex items-center gap-2.5">
                <Mascot play={["01_walk"]} scale={0.5} pauseMs={2400} />
                <span className="font-pixel text-lg leading-none tracking-wide">Invoice Scam Sniffer</span>
              </Link>
              <GatewayStatus />
            </div>
          </header>
          <main className="mx-auto max-w-5xl px-4 py-8 sm:py-10">{children}</main>
          <footer className="mx-auto max-w-5xl px-4 pb-8 text-xs text-ink-3">Cardano Preprod · Masumi · x402 — TUM Blockchain &amp; AI Hackathon 2026</footer>
        </Providers>
      </body>
    </html>
  );
}
