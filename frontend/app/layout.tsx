import type { Metadata } from "next";
import Link from "next/link";
import { Providers } from "./providers";
import { GatewayStatus } from "@/components/GatewayStatus";
import "./globals.css";

export const metadata: Metadata = {
  title: "Invoice Scam Sniffer",
  description: "E-Rechnungen mit Cardano-Zahlungsadresse prüfen lassen, bezahlt per x402 auf Cardano Preprod.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <body className="min-h-screen">
        <Providers>
          <header className="border-b border-line bg-surface">
            <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
              <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
                <span aria-hidden className="grid h-7 w-7 place-items-center rounded-md bg-brand text-sm text-brand-ink">IS</span>
                Invoice Scam Sniffer
              </Link>
              <GatewayStatus />
            </div>
          </header>
          <main className="mx-auto max-w-5xl px-4 py-6 sm:py-8">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
