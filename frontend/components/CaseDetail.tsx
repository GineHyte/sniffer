"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { getCase, type CaseView, type CaseWithCheck, type FiredCriterion, type InvestigatorView } from "@/lib/api";
import { BAND_LABEL, INSPECTION_HINT, isSettled, outcome, steps, type StepState, type Tone } from "@/lib/progress";
import { Mascot, type Animation } from "./Mascot";
import { Badge, TxLink, useGatewayConfig, type BadgeTone } from "./ui";

const TONE: Record<Tone, BadgeTone> = { pending: "info", approved: "ok", rejected: "bad", attention: "warn" };
const BAND_TONE: Record<string, BadgeTone> = { low: "ok", medium: "warn", high: "bad" };
const ROLE_LABEL: Record<string, string> = { invoice: "Invoice agent", wallet: "Wallet agent", supplier: "Supplier agent" };
const VERDICT_TONE: Record<string, BadgeTone> = { CLEAR: "ok", CONCERN: "warn", CRITICAL: "bad", INSUFFICIENT_DATA: "neutral" };
const AGENT_LABEL: Record<string, string> = { invoice: "Invoice", wallet: "Wallet", research: "Research" };
const REACTION: Record<Tone, Animation> = {
  pending: "baby_03_glasses",
  approved: "baby_02_sit",
  rejected: "baby_04c_sad_lying",
  attention: "baby_04b_sad_stand",
};

/** The pay decision sets the mood, even if a later step (payout) needs attention. */
function mood(view: CaseView): Animation {
  if (view.decision?.decision === "PAY") return REACTION.approved;
  if (view.decision?.decision === "DONT_PAY") return REACTION.rejected;
  return REACTION[outcome(view).tone];
}

/** Polls one case every 2 s until it is settled (payout confirmed or a final stop). */
export function useCase(caseId: string | null) {
  return useQuery({
    queryKey: ["case", caseId],
    queryFn: () => getCase(caseId!),
    enabled: Boolean(caseId),
    refetchInterval: (query) => (query.state.data && isSettled(query.state.data.case) ? false : 2000),
  });
}

export function OutcomeBadge({ data }: { data: CaseWithCheck | undefined }) {
  if (!data) return <Badge>Loading …</Badge>;
  const { tone, label } = outcome(data.case);
  return (
    <Badge tone={TONE[tone]}>
      {tone === "pending" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {label}
    </Badge>
  );
}

const DOT: Record<StepState, string> = {
  done: "bg-ok border-ok",
  active: "bg-brand border-brand animate-pulse",
  pending: "bg-surface border-line",
  skipped: "bg-surface-2 border-line",
  failed: "bg-bad border-bad",
};

function Stepper({ data }: { data: CaseWithCheck }) {
  return (
    <ol className="grid grid-cols-3 gap-x-2 gap-y-3 sm:grid-cols-6">
      {steps(data.case).map((step) => (
        <li key={step.id} className="flex items-center gap-2 text-xs">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-[2px] border-2 ${DOT[step.state]}`} />
          <span className={step.state === "pending" || step.state === "skipped" ? "text-ink-3" : "text-ink"}>
            {step.label}
            {step.state === "skipped" && <span className="text-ink-3"> · skipped</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Score({ score, band }: { score: number | null; band: string | null }) {
  const color = band === "high" ? "bg-bad" : band === "medium" ? "bg-warn" : "bg-ok";
  return (
    <div className="min-w-40">
      <div className="flex items-baseline gap-1">
        <span className="tabular font-pixel text-4xl leading-none">{score ?? "–"}</span>
        <span className="text-sm text-ink-3">/ 100</span>
      </div>
      {/* Ten blocks, like a hotbar: each one is 10 points. */}
      <div className="mt-2 grid grid-cols-10 gap-0.5">
        {Array.from({ length: 10 }, (_, i) => (
          <span key={i} className={`h-2 rounded-[1px] transition-colors ${(score ?? 0) > i * 10 ? color : "bg-surface-2"}`} />
        ))}
      </div>
      {band && (
        <Badge tone={BAND_TONE[band]} className="mt-2">
          {BAND_LABEL[band]}
        </Badge>
      )}
    </div>
  );
}

function CriteriaTable({ title, rows }: { title: string; rows: FiredCriterion[] }) {
  if (!rows.length) return null;
  return (
    <div>
      <h4 className="mb-2 font-pixel text-sm text-ink-2">{title}</h4>
      <ul className="divide-y divide-line rounded-lg border border-line">
        {rows.map((row) => (
          <li key={row.id} className="grid grid-cols-[3.5rem_1fr_auto] items-start gap-3 px-3 py-2.5 text-sm">
            <span className="font-mono text-xs text-ink-2">{row.id}</span>
            <div className="min-w-0">
              <div className="font-medium">{row.name}</div>
              <div className="break-words text-xs text-ink-2">{row.evidence}</div>
              {row.agent && <div className="mt-1 text-[11px] text-ink-3">→ {AGENT_LABEL[row.agent] ?? row.agent} agent</div>}
            </div>
            <span className={`tabular text-sm font-semibold ${row.points < 0 ? "text-ok" : "text-ink"}`}>
              {row.points > 0 ? "+" : ""}
              {row.points}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Investigator({ role, view, mock }: { role: string; view: InvestigatorView; mock: boolean }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-3 text-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-medium">{ROLE_LABEL[role] ?? role}</span>
        {view.verdict ? <Badge tone={VERDICT_TONE[view.verdict]}>{view.verdict}</Badge> : <Badge tone="info">running</Badge>}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-ink-3">Payment</dt>
        <dd>{view.payment ?? "–"}</dd>
        <dt className="text-ink-3">Report</dt>
        <dd>{view.report ?? "pending"}</dd>
        <dt className="text-ink-3">Tx</dt>
        <dd>
          <TxLink hash={view.payment_tx_hash} mock={mock} />
        </dd>
      </dl>
    </div>
  );
}

export function CaseBody({ data, mock }: { data: CaseWithCheck; mock: boolean }) {
  const view = data.case;
  const check = data.check;
  const reasons = view.decision?.decline_reasons ?? [];
  return (
    <div className="space-y-5">
      <Stepper data={data} />

      <div className="flex flex-wrap items-start gap-6">
        <Mascot play={mood(view)} scale={3} />
        <Score score={check?.risk_score ?? view.risk_score} band={check?.band ?? view.band} />
        <dl className="grid flex-1 grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-ink-3">Check fee</dt>
          <dd>
            <TxLink hash={view.intake?.tx_hash} mock={mock} /> <span className="text-xs text-ink-3">({view.intake?.state ?? "–"})</span>
          </dd>
          <dt className="text-ink-3">Decision</dt>
          <dd>
            {view.decision ? `${view.decision.decision} · ${view.decision.decided_by === "agents" ? "after agent review" : "initial check"}` : "pending"}
          </dd>
          <dt className="text-ink-3">Payout</dt>
          <dd>
            {view.payout ? (
              <>
                <TxLink hash={view.payout.tx_hash} mock={mock} /> <span className="text-xs text-ink-3">({view.payout.state ?? view.payout.phase})</span>
              </>
            ) : view.decision?.final_decision === "rejected" ? (
              "none"
            ) : (
              "pending"
            )}
          </dd>
        </dl>
      </div>

      {view.inspection && (
        <div className="rounded-lg bg-warn-bg px-3 py-2 text-sm text-warn">
          Stopped: <span className="font-mono text-xs">{view.inspection.code}</span>
          {INSPECTION_HINT[view.inspection.code] ? ` – ${INSPECTION_HINT[view.inspection.code]}` : ""}
        </div>
      )}

      {reasons.length > 0 && (
        <div className="rounded-lg border border-bad/30 bg-bad-bg p-3">
          <h4 className="mb-1.5 text-sm font-semibold text-bad">Reasons for “Don’t pay”</h4>
          <ul className="space-y-1 text-sm">
            {reasons.map((reason) => (
              <li key={reason.id}>
                <span className="font-mono text-xs text-ink-2">{reason.id}</span> {reason.text}
                {reason.evidence && <span className="block text-xs text-ink-2">{reason.evidence}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {check && (
        <div className="space-y-4">
          {check.checks_incomplete.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-2">
              Not fully checked:
              {check.checks_incomplete.map((code) => (
                <Badge key={code} tone="warn">
                  {code}
                </Badge>
              ))}
            </div>
          )}
          <CriteriaTable title={`Triggered criteria (${check.criteria.length})`} rows={check.criteria} />
          <CriteriaTable title="Mitigating factors" rows={check.reducers} />
          {check.criteria.length === 0 && check.reducers.length === 0 && <p className="text-sm text-ink-2">No criteria triggered.</p>}
        </div>
      )}
      {data.check_error && <p className="text-xs text-warn">Criteria unavailable right now ({data.check_error}).</p>}

      {view.investigators && (
        <div>
          <h4 className="mb-2 font-pixel text-sm text-ink-2">Agent review (paid via x402)</h4>
          <div className="grid gap-2 sm:grid-cols-3">
            {(["invoice", "wallet", "supplier"] as const).map((role) => (
              <Investigator key={role} role={role} view={view.investigators![role]} mock={mock} />
            ))}
          </div>
        </div>
      )}

      <p className="text-xs text-ink-3">
        Case{" "}
        <Link href={`/cases/${view.case_id}`} className="font-mono hover:underline">
          {view.case_id}
        </Link>
      </p>
    </div>
  );
}

/** Stand-alone case view (deep link /cases/[caseId]). */
export function CaseDetail({ caseId }: { caseId: string }) {
  const { data, error, isLoading } = useCase(caseId);
  const config = useGatewayConfig().data;
  if (isLoading) return <p className="text-sm text-ink-2">Loading case …</p>;
  if (error || !data) return <p className="text-sm text-bad">Case not found or gateway unreachable.</p>;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-pixel text-2xl">Case</h1>
        <OutcomeBadge data={data} />
      </div>
      <div className="rounded-xl border border-line bg-surface p-4 sm:p-5">
        <CaseBody data={data} mock={config?.mode === "mock"} />
      </div>
    </div>
  );
}
