"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { GatewayError, submitInvoice } from "@/lib/api";
import { caseIdFor, checkFile, formatAda, shortHash } from "@/lib/einvoice";
import { previewOf } from "@/lib/preview";
import { countBy, initialQueue, nextToPay, persistable, queueReducer, restorable, type Item } from "@/lib/queue";
import { CaseBody, OutcomeBadge, useCase } from "./CaseDetail";
import type { Prop } from "./GroundDecor";
import { Ground, Mascot } from "./Mascot";
import { Badge, Button, Card, useGatewayConfig, type BadgeTone } from "./ui";

// Pause after Main refused new intakes (503 too_many_unconfirmed_intakes): Preprod confirmations take ~20–60 s.
const STORAGE_KEY = "sniffer.queue.v1";
const RETRY_MS = { live: 20_000, mock: 2_000 } as const;
// Props on the hero grass, bunched around the sniffer (right edge) and sparse to the left, so the strip never looks tiled.
const HERO_DECOR: Prop[] = [
  { sprite: "poppy", left: "4%" },
  { sprite: "pebble", left: "15%" },
  { sprite: "mossRock", left: "27%" },
  { sprite: "daisy", left: "41%", flip: true },
  { sprite: "mushroom", left: "54%" },
  { sprite: "daisy", left: "61%" },
  { sprite: "bush", left: "66%" },
  { sprite: "poppy", left: "71%", flip: true },
  { sprite: "rock", left: "74%" },
  { sprite: "pebble", left: "79%" },
];

const ERROR_TEXT: Record<string, string> = {
  gateway_unreachable: "Gateway unreachable (is npm run customer running?).",
  payer_balance_too_low: "Demo wallet has too little tADA.",
  not_an_einvoice: "No e-invoice detected.",
  xml_too_large: "XML too large.",
  payment_failed: "Payment stopped – check the journal in .local/demo.",
  main_unavailable: "Sniffer (Main API) is not responding.",
};


let keySeq = 0;

async function toItem(file: File, maxXmlBytes: number): Promise<Item> {
  const base = { key: `${Date.now().toString(36)}-${++keySeq}`, fileName: file.name, sizeBytes: file.size, preview: null, error: null, txHash: null, existing: false, attempts: 0 };
  const checked = checkFile(file.name, new Uint8Array(await file.arrayBuffer()), maxXmlBytes);
  if (!checked.ok) return { ...base, xml: null, caseId: null, phase: "invalid", error: checked.error };
  return { ...base, xml: checked.xml, caseId: await caseIdFor(checked.xml), preview: previewOf(checked.xml), phase: "ready" };
}

export function UploadWorkbench() {
  const config = useGatewayConfig().data;
  const [queue, dispatch] = useReducer(queueReducer, initialQueue);
  const [now, setNow] = useState(() => Date.now());
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const mode = config?.mode ?? "live";

  // Submitted cases survive a reload or a visit to a case page; storage may be unavailable (private mode).
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = sessionStorage.getItem(STORAGE_KEY);
    } catch {}
    const items = restorable(saved);
    if (items.length) dispatch({ type: "restore", items });
  }, []);
  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(persistable(queue)));
    } catch {}
  }, [queue]);

  // Clock for the pause countdown and for waking the queue after a refusal.
  useEffect(() => {
    if (!queue.pausedUntil) return;
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      dispatch({ type: "wake", now: t });
    }, 500);
    return () => clearInterval(timer);
  }, [queue.pausedUntil]);

  // The payer loop: at most one POST /api/invoices at a time, in list order.
  useEffect(() => {
    const next = nextToPay(queue, Date.now());
    if (!next?.xml) return;
    dispatch({ type: "payStarted", key: next.key });
    submitInvoice(next.xml).then(
      (result) => dispatch({ type: "paid", key: next.key, caseId: result.case_id, txHash: result.payment_tx_hash, existing: result.existing }),
      (error: unknown) => {
        const failure = error instanceof GatewayError ? error : new GatewayError(0, "gateway_unreachable");
        if (failure.code === "too_many_unconfirmed_intakes") dispatch({ type: "refused", key: next.key, retryAt: Date.now() + RETRY_MS[mode] });
        else dispatch({ type: "failed", key: next.key, error: ERROR_TEXT[failure.code] ?? failure.message ?? failure.code });
      },
    );
  }, [queue, mode]);

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (!list.length) return;
      dispatch({ type: "add", items: await Promise.all(list.map((file) => toItem(file, config?.max_xml_bytes ?? 500_000))) });
    },
    [config?.max_xml_bytes],
  );

  const ready = countBy(queue, "ready");
  const open = countBy(queue, "queued", "paying", "waiting");
  const price = config ? BigInt(config.price_lovelace) : 0n;
  const paused = queue.pausedUntil > now && countBy(queue, "waiting") > 0;

  return (
    <div className="space-y-8">
      <div>
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-2">
          <div className="max-w-xl pb-10">
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-brand">Agentic Commerce on Cardano</p>
            <h1 className="mt-2 font-pixel text-3xl leading-tight sm:text-4xl">Check e-invoices</h1>
            <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
              Upload XRechnung or ZUGFeRD XML with a Cardano payment address. Each invoice is paid for individually via x402 and checked by the Sniffer:
              an initial check, three agents for medium risk, then approval and payout or a reasoned rejection.
            </p>
          </div>
          <Mascot play={dragging ? "baby_03b_glasses_bounce" : "baby_03c_glasses_idle"} scale={4} onGround className="relative z-10 ml-auto" label="Sniffer" />
        </div>
        <Ground decor={HERO_DECOR} decorCell={4} />
      </div>

      <div
        role="button"
        tabIndex={0}
        onClick={() => input.current?.click()}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void addFiles(e.dataTransfer.files);
        }}
        className={`group flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-12 text-center transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
          dragging ? "border-brand bg-info-bg" : "border-line bg-surface hover:border-brand/60 hover:bg-surface-2/40"
        }`}
      >
        <svg aria-hidden viewBox="0 0 24 24" className="mb-3 h-8 w-8 text-brand transition-transform group-hover:-translate-y-0.5" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <p className="font-medium">Drag XML files here or click</p>
        <p className="mt-1 text-xs text-ink-3">Multiple files allowed · max. {Math.floor((config?.max_xml_bytes ?? 500_000) / 1000)} kB per file · .xml only</p>
        <input
          ref={input}
          type="file"
          accept=".xml,application/xml,text/xml"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {queue.items.length > 0 && (
        <Card className="rise overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
            <div className="text-sm">
              <span className="font-medium">{queue.items.length} file{queue.items.length === 1 ? "" : "s"}</span>
              {paused && (
                <span className="ml-2 text-warn">
                  Sniffer is waiting for earlier payments to confirm – next try in {Math.ceil((queue.pausedUntil - now) / 1000)} s
                </span>
              )}
              {!paused && open > 0 && <span className="ml-2 text-ink-2">{open} in queue</span>}
            </div>
            <div className="flex flex-wrap gap-2">
              {countBy(queue, "invalid", "duplicate") > 0 && (
                <Button variant="ghost" onClick={() => dispatch({ type: "clearDone" })}>
                  Remove invalid
                </Button>
              )}
              <Button variant="ghost" onClick={() => dispatch({ type: "clearAll" })}>
                Clear list
              </Button>
              <Button disabled={!ready || !config || (!config.main_ok && config.mode === "live")} onClick={() => dispatch({ type: "start" })}>
                {ready ? `Check ${ready} · ${formatAda(price * BigInt(ready))} tADA` : "Check"}
              </Button>
            </div>
          </div>
          {ready > 0 && config && (
            <p className="border-b border-line bg-surface-2 px-4 py-2 text-xs text-ink-2">
              {config.mode === "mock"
                ? "Mock mode: nothing is paid."
                : `“Check” makes the demo wallet “${config.wallet}” pay ${formatAda(price)} tADA per new invoice on Cardano Preprod. Invoices already paid for are not paid again.`}
            </p>
          )}
          {open > 0 && (
            <div className="border-b border-line bg-surface-2/50 px-4 pt-3">
              <div className="flex items-end gap-4">
                <Mascot play={paused ? "baby_00_idle" : "baby_01_walk"} scale={2} onGround className="relative z-10" />
                <p className="pb-6 font-pixel text-sm text-ink-2">{paused ? "Short break …" : "The Sniffer is sniffing …"}</p>
              </div>
              <Ground height={24} />
            </div>
          )}
          <ul className="divide-y divide-line">
            {queue.items.map((item) => (
              <QueueRow key={item.key} item={item} mock={config?.mode === "mock"} onRemove={() => dispatch({ type: "remove", key: item.key })} onRetry={() => dispatch({ type: "retry", key: item.key })} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

const PHASE: Record<Item["phase"], { tone: BadgeTone; label: string }> = {
  invalid: { tone: "bad", label: "Invalid" },
  duplicate: { tone: "neutral", label: "Duplicate" },
  ready: { tone: "neutral", label: "Ready" },
  queued: { tone: "info", label: "Queued" },
  paying: { tone: "info", label: "Paying" },
  waiting: { tone: "warn", label: "Paused" },
  submitted: { tone: "info", label: "Submitted" },
  failed: { tone: "bad", label: "Error" },
};

function QueueRow({ item, mock, onRemove, onRetry }: { item: Item; mock: boolean; onRemove: () => void; onRetry: () => void }) {
  const [open, setOpen] = useState(false);
  const { data } = useCase(item.phase === "submitted" ? item.caseId : null);
  const p = item.preview;
  return (
    <li className="rise px-4 py-3 transition-colors hover:bg-surface-2/40">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-[1_1_14rem]">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium" title={item.fileName}>
              {item.fileName}
            </span>
            {item.existing && <Badge>already paid</Badge>}
          </div>
          {p ? (
            <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-ink-2">
              {p.invoiceNumber && <span>{p.invoiceNumber}</span>}
              {p.seller && <span>{p.seller}</span>}
              {p.amount && (
                <span className="tabular">
                  {p.amount} {p.currency ?? ""}
                </span>
              )}
              {p.wallet && (
                <span className="font-mono" title={p.wallet}>
                  {shortHash(p.wallet, 10)}
                </span>
              )}
            </div>
          ) : (
            item.error && <div className="mt-0.5 text-xs text-bad">{item.error}</div>
          )}
          {p && item.error && <div className="mt-0.5 text-xs text-bad">{item.error}</div>}
        </div>
        <div className="flex items-center gap-2">
          {item.phase === "submitted" ? <OutcomeBadge data={data} /> : <Badge tone={PHASE[item.phase].tone}>{PHASE[item.phase].label}</Badge>}
          {data?.case.risk_score != null && <span className="tabular w-10 text-right font-pixel text-base">{data.case.risk_score}</span>}
          {item.phase === "failed" && (
            <Button variant="ghost" onClick={onRetry}>
              Retry
            </Button>
          )}
          {["invalid", "duplicate", "ready", "queued", "failed"].includes(item.phase) && (
            <button onClick={onRemove} className="rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-ink" aria-label="Remove">
              ✕
            </button>
          )}
          {data && (
            <Button variant="ghost" onClick={() => setOpen(!open)} aria-expanded={open}>
              {open ? "Less" : "Details"}
            </Button>
          )}
        </div>
      </div>
      {open && data && (
        <div className="mt-3 rounded-lg border border-line bg-bg p-3 sm:p-4">
          <CaseBody data={data} mock={mock} />
        </div>
      )}
    </li>
  );
}
