// Maps Main's case view (docs/openapi/main-api.yaml CaseView) to the stepper and the outcome badge.
import type { CaseView } from "./api.ts";

export type StepState = "done" | "active" | "pending" | "skipped" | "failed";
export type Step = { id: string; label: string; state: StepState };
export type Tone = "pending" | "approved" | "rejected" | "attention";

const TERMINAL = new Set(["completed", "failed", "needs_inspection"]);
const PAYOUT_OPEN = new Set(["authorized", "submitting", "submitted"]);

/** True when nothing will change any more, so polling can stop (mirrors main/case-store.mjs hasOpenWork). */
export function isSettled(view: CaseView): boolean {
  if (!TERMINAL.has(view.status)) return false;
  if (view.status === "needs_inspection") return true;
  if (view.intake?.state === "submitted") return false;
  return !(view.status === "completed" && view.payout?.state && PAYOUT_OPEN.has(view.payout.state));
}

export function steps(view: CaseView): Step[] {
  const s = view.status;
  const intake = view.intake?.state ?? "confirmed";
  const decided = view.decision !== null;
  const rejected = view.decision?.final_decision === "rejected";
  const payoutState = view.payout?.state ?? null;
  const list: Step[] = [
    { id: "paid", label: "Paid", state: "done" },
    { id: "confirmed", label: "Payment confirmed", state: intake === "confirmed" ? "done" : intake === "failed" ? "failed" : "active" },
    { id: "check", label: "Initial check", state: view.band !== null ? "done" : s === "initial_check" ? "active" : "pending" },
    {
      id: "review",
      label: "Agent review",
      state: view.band === "low" || view.band === "high" ? "skipped" : view.band === "medium" ? (decided || s === "deciding" ? "done" : "active") : "pending",
    },
    { id: "decision", label: "Decision", state: decided ? "done" : s === "deciding" ? "active" : "pending" },
    {
      id: "payout",
      label: "Payout",
      state: rejected
        ? "skipped"
        : payoutState === "confirmed"
          ? "done"
          : payoutState === "failed" || view.payout?.phase === "error" || view.payout?.phase === "refused"
            ? "failed"
            : s === "payout" || (payoutState !== null && PAYOUT_OPEN.has(payoutState))
              ? "active"
              : "pending",
    },
  ];
  if (s === "failed" || s === "needs_inspection") {
    const stuck = list.find((step) => step.state === "active" || step.state === "pending");
    if (stuck && !list.some((step) => step.state === "failed")) stuck.state = "failed";
    for (const step of list) if (step.state === "active") step.state = "pending";
  }
  return list;
}

/** Customer-facing outcome. Never says "fraud": a decline names its factual reasons instead. */
export function outcome(view: CaseView): { tone: Tone; label: string } {
  if (view.status === "needs_inspection") return { tone: "attention", label: "Manual review needed" };
  if (view.status === "failed") return { tone: "attention", label: "Aborted" };
  if (view.decision?.final_decision === "rejected") return { tone: "rejected", label: "Don’t pay" };
  if (view.decision?.final_decision === "approved")
    return { tone: "approved", label: view.payout?.state === "confirmed" ? "Approved · paid out" : "Approved" };
  if (view.status === "investigating") return { tone: "pending", label: "Agents checking" };
  if (view.status === "accepted" && view.intake?.state === "submitted") return { tone: "pending", label: "Confirming payment" };
  return { tone: "pending", label: "Checking" };
}

export const BAND_LABEL: Record<string, string> = { low: "Low risk", medium: "Medium risk", high: "High risk" };

export const INSPECTION_HINT: Record<string, string> = {
  intake_not_confirmed: "The payment failed on-chain; no funds were moved.",
  intake_unconfirmed: "The payment was not confirmed in time; no funds were moved.",
  initial_check_unreachable: "The check backend was unreachable.",
};
