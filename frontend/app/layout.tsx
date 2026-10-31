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
  title: "Sniffer",
  description: "Check e-invoices with a Cardano payment address, paid via x402 on Cardano Preprod.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${body.variable} ${display.variable}`}>
      <body className="flex min-h-screen flex-col">
        <Providers>
          <header className="border-b border-line bg-surface/80 backdrop-blur">
            <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
              <Link href="/" className="flex items-center gap-2.5">
                <Mascot play="baby_01_walk" scale={1} />
                <span className="font-pixel text-lg leading-none tracking-wide">Sniffer</span>
              </Link>
              <div className="flex items-center gap-4">
                <Link href="/criteria" className="text-sm text-ink-2 hover:text-ink hover:underline">
                  Criteria
                </Link>
                <GatewayStatus />
              </div>
            </div>
          </header>
          <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:py-10">{children}</main>
          <footer className="mx-auto w-full max-w-5xl px-4 pb-4 text-xs text-ink-3">Cardano Preprod · Masumi · x402 — TUM Blockchain &amp; AI Hackathon 2026</footer>
          <div aria-hidden className="ground h-9 w-full" />
        </Providers>
      </body>
    </html>
  );
}
