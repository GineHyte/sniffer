"use client";

import { useQuery } from "@tanstack/react-query";
import { EXPLORER_TX, getConfig } from "@/lib/api";
import { shortHash } from "@/lib/einvoice";

export type BadgeTone = "neutral" | "info" | "ok" | "warn" | "bad";

const BADGE: Record<BadgeTone, string> = {
  neutral: "bg-surface-2 text-ink-2",
  info: "bg-info-bg text-brand",
  ok: "bg-ok-bg text-ok",
  warn: "bg-warn-bg text-warn",
  bad: "bg-bad-bg text-bad",
};

export function Badge({ tone = "neutral", children, className = "" }: { tone?: BadgeTone; children: React.ReactNode; className?: string }) {
  return <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-[4px] px-2 py-0.5 text-xs font-medium ${BADGE[tone]} ${className}`}>{children}</span>;
}

export function Button({
  variant = "primary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" }) {
  const look =
    variant === "primary"
      ? "bg-brand text-brand-ink [--shade:var(--brand-shade)] hover:brightness-105 disabled:opacity-40"
      : "border border-line bg-surface text-ink-2 [--shade:var(--line)] hover:bg-surface-2 hover:text-ink disabled:opacity-40";
  return (
    <button
      {...props}
      className={`btn-block mb-[3px] inline-flex items-center justify-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium transition-[transform,box-shadow,filter,background-color] duration-75 disabled:cursor-not-allowed ${look} ${className}`}
    />
  );
}

export function TxLink({ hash, mock }: { hash: string | null | undefined; mock?: boolean }) {
  if (!hash) return <span className="text-ink-3">–</span>;
  if (mock) return <span className="font-mono text-xs text-ink-3" title="Mock: nicht on-chain">{shortHash(hash, 6)}</span>;
  return (
    <a href={`${EXPLORER_TX}${hash}`} target="_blank" rel="noreferrer" className="font-mono text-xs text-brand hover:underline" title={hash}>
      {shortHash(hash, 6)} ↗
    </a>
  );
}

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <section className={`rounded-xl border border-line bg-surface shadow-[0_1px_0_0_var(--line)] ${className}`}>{children}</section>;
}

/** Gateway configuration, refreshed every 15 s (Main reachability can change). */
export function useGatewayConfig() {
  return useQuery({ queryKey: ["config"], queryFn: getConfig, refetchInterval: 15_000 });
}
