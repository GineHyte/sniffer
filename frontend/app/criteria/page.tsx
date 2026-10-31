import type { Metadata } from "next";
import Link from "next/link";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Badge, Card, type BadgeTone } from "@/components/ui";

// Information page: every criterion of the initial check. Points, names, customer texts, agent tasks and
// parameters come from backend/config/criteria.json on each request, so the page follows the config.
// The trigger conditions summarise docs/initial-check-spec.md 3.6; keep them in sync when a rule changes.

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Criteria · Sniffer" };

const CRITERIA_FILE = resolve(process.cwd(), "..", "backend", "config", "criteria.json");

type Agent = "invoice" | "wallet" | "research";
type Criterion = {
  id: string;
  kind: "ko" | "score" | "reducer";
  points?: number;
  points_tiers?: { below_days: number; points: number }[];
  reason_type?: "formal" | "risk";
  name: string;
  agent: Agent | null;
  customer_text: string | null;
  agent_task: string | null;
};
type Params = {
  new_wallet_limit_eur: string;
  max_invoice_eur: string;
  round_amount_multiple_eur: string;
  approval_thresholds_eur: string[];
  threshold_margin_percent: number;
  median_factor: number;
  median_min_invoices: number;
  issue_date_max_age_days: number;
  due_min_days: number;
  wallet_trust_reducer_min: string;
  pair_reducer_min_approved: number;
};
type Config = {
  version: string;
  bands: { medium_min: number; high_min: number };
  ko_points: number;
  reducer_cap: number;
  reducers_blocked_by_points: number;
  params: Params;
  criteria: Criterion[];
  incomplete_tasks: Record<string, { agent: Agent; task: string }>;
};

const AGENT_LABEL: Record<Agent, string> = {
  invoice: "Invoice investigator",
  wallet: "Wallet investigator",
  research: "Supplier investigator",
};

// Codes in checks_incomplete that force at least medium (spec 3.8, band rule 5).
const FORCES_MEDIUM = new Set(["MUSTANG_UNAVAILABLE", "BLOCKFROST_UNAVAILABLE", "SANCTIONS_LIST_STALE", "CURRENCY_NOT_EUR"]);

function trigger(id: string, p: Params, c: Criterion): string {
  switch (id) {
    case "KO-1": return "The XML fails validation: a required field is missing, it does not parse, or the XRechnung/Mustang validator reports errors.";
    case "KO-2": return "The payment address (BT-84) is not a valid Cardano address, or it belongs to another network than the expected one.";
    case "KO-3": return "The exact same invoice was already submitted (identical invoice hash).";
    case "KO-4": return "The wallet is on the OFAC SDN list, or the seller name (BT-27) matches an OFAC entry.";
    case "KO-6": return "The wallet or the supplier is blocked internally (for example after a critical wallet report).";
    case "S-1": return "The wallet is known, but was never approved together with this supplier.";
    case "S-2": return "VIES reports the seller's VAT ID as invalid.";
    case "S-3": return "The supplier is known, but was never approved with this wallet.";
    case "S-4": return "The seller's country (BT-40) is on the high-risk country list.";
    case "S-7": return "Name, e-mail domain, phone or postal address differ from the supplier's last approved invoice.";
    case "S-8": return "The seller's contact e-mail (BT-43 or BT-34) uses a free-mail domain.";
    case "S-9": return "There is no earlier invoice from this supplier.";
    case "W-1": return "Chainabuse has at least one report on the address that is trusted or checked.";
    case "W-2": {
      const tiers = (c.points_tiers ?? []).map((t) => `under ${t.below_days} days: ${t.points} points`).join("; ");
      return `The address's first transaction is recent (${tiers}).`;
    }
    case "W-4": return "The address has no transactions at all.";
    case "W-6": return "Chainabuse has reports on the address, none of them trusted or checked.";
    case "I-2":
      return p.new_wallet_limit_eur === p.max_invoice_eur
        ? `The amount (BT-112) is above ${p.max_invoice_eur} EUR. The separate new-wallet limit is switched off (equal to the maximum).`
        : `The amount (BT-112) is above ${p.new_wallet_limit_eur} EUR while the wallet trust is 0 or lower, or above ${p.max_invoice_eur} EUR in any case.`;
    case "I-3": return "Buyer name, buyer VAT ID (BT-48) or postcode (BT-53) differ from our buyer master data.";
    case "I-4": return `The supplier has at least ${p.median_min_invoices} approved EUR invoices and the amount is more than ${p.median_factor}× their median.`;
    case "I-5": return "Notes (BT-22), BT-20 or BT-83 contain pressure wording such as \"heute noch\".";
    case "I-6": return `The issue date (BT-2) lies in the future or more than ${p.issue_date_max_age_days} days back.`;
    case "I-7": return `The due date (BT-9) is less than ${p.due_min_days} days after the issue date.`;
    case "I-8": return "There is no order reference (BT-13), or it is not an open order of this supplier.";
    case "I-10":
      return `The amount is a whole multiple of ${p.round_amount_multiple_eur} EUR, or up to ${p.threshold_margin_percent} % below an approval threshold (${p.approval_thresholds_eur.join(", ")} EUR).`;
    case "I-11": return "Payment means (BT-81) is not ZZZ, or the payment details (BT-82) are missing, malformed or name another network.";
    case "I-12": return "The invoice is a corrected invoice (type code 384). Adds no points, but forces at least medium.";
    case "T-1": return `The effective wallet trust is at least ${p.wallet_trust_reducer_min}.`;
    case "T-2": return `This supplier–wallet pair was approved at least ${p.pair_reducer_min_approved} times.`;
    case "T-3": return "The order reference (BT-13) matches an open order of this supplier.";
    case "T-4": return "VIES reports the seller's VAT ID as valid.";
    default: return "–";
  }
}

const GROUPS: { prefix: string; title: string; blurb: string }[] = [
  { prefix: "KO-", title: "K.O. criteria", blurb: "Any hit ends the check: band high, invoice declined, no investigators." },
  { prefix: "S-", title: "Supplier", blurb: "Who sent the invoice, and does their history fit?" },
  { prefix: "W-", title: "Wallet", blurb: "The Cardano payment address: on-chain age, scam reports, history." },
  { prefix: "I-", title: "Invoice", blurb: "Amounts, dates, buyer data and payment details in the XML." },
  { prefix: "T-", title: "Reducers", blurb: "Trust signals that lower the score." },
];

function pointsLabel(c: Criterion, koPoints: number): { text: string; tone: BadgeTone } {
  if (c.kind === "ko") return { text: `K.O. · ${koPoints}`, tone: "bad" };
  if (c.points_tiers) return { text: c.points_tiers.map((t) => `+${t.points}`).join(" / "), tone: "warn" };
  const n = c.points ?? 0;
  if (n < 0) return { text: `${n}`, tone: "ok" };
  return { text: `+${n}`, tone: n >= 20 ? "warn" : "neutral" };
}

function CriterionRow({ c, cfg }: { c: Criterion; cfg: Config }) {
  const pts = pointsLabel(c, cfg.ko_points);
  return (
    <li className="grid gap-3 border-t border-line px-4 py-4 first:border-t-0 sm:grid-cols-[5.5rem_1fr]">
      <div className="flex items-start gap-2 sm:flex-col">
        <span className="font-mono text-sm font-semibold">{c.id}</span>
        <Badge tone={pts.tone}>{pts.text}</Badge>
      </div>
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium">{c.name}</h3>
          {c.reason_type && <Badge tone={c.reason_type === "risk" ? "bad" : "neutral"}>{c.reason_type}</Badge>}
          {c.agent && <Badge tone="info">{AGENT_LABEL[c.agent]}</Badge>}
        </div>
        <p className="text-sm text-ink-2">
          <span className="font-medium text-ink">Fires when: </span>
          {trigger(c.id, cfg.params, c)}
        </p>
        {c.customer_text && (
          <p className="text-sm text-ink-2" lang="de">
            <span className="font-medium text-ink" lang="en">Customer sees: </span>
            {c.customer_text}
          </p>
        )}
        {c.agent_task && (
          <p className="text-sm text-ink-2" lang="de">
            <span className="font-medium text-ink" lang="en">Investigator task (medium): </span>
            {c.agent_task}
          </p>
        )}
      </div>
    </li>
  );
}

export default async function CriteriaPage() {
  const cfg = JSON.parse(await readFile(CRITERIA_FILE, "utf8")) as Config;
  const { bands, params: p } = cfg;
  const scored = cfg.criteria.filter((c) => c.kind !== "reducer").length;

  return (
    <div className="space-y-8">
      <Link href="/" className="text-sm text-ink-2 hover:underline">
        ← Back to upload
      </Link>

      <header className="space-y-3">
        <h1 className="font-pixel text-3xl tracking-wide">Check criteria</h1>
        <p className="max-w-3xl text-ink-2">
          Every invoice goes through the initial check first: {scored} criteria and {cfg.criteria.length - scored} reducers,
          evaluated against the XML, VIES, Blockfrost, Chainabuse, the OFAC list, open orders and the supplier&apos;s history.
          The result is a risk score from 0 to 100 and a band. Config version {cfg.version}.
        </p>
      </header>

      <section aria-labelledby="bands" className="space-y-3">
        <h2 id="bands" className="text-lg font-semibold">From score to decision</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Card className="space-y-1 p-4">
            <Badge tone="ok">low · score under {bands.medium_min}</Badge>
            <p className="text-sm text-ink-2">Approved by the initial check. The payout goes out right away, no investigators.</p>
          </Card>
          <Card className="space-y-1 p-4">
            <Badge tone="warn">medium · {bands.medium_min} to {bands.high_min - 1}</Badge>
            <p className="text-sm text-ink-2">Main pays the investigators, each gets the tasks of the criteria that fired. Main decides on their reports.</p>
          </Card>
          <Card className="space-y-1 p-4">
            <Badge tone="bad">high · {bands.high_min} or more, or any K.O.</Badge>
            <p className="text-sm text-ink-2">Declined by the initial check, with up to three reasons shown to the customer.</p>
          </Card>
        </div>
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">
          <li>Score = sum of fired criteria + reducers, clamped to 0–100. A K.O. counts {cfg.ko_points} points.</li>
          <li>
            Reducers apply only without a K.O. and when no fired criterion has {cfg.reducers_blocked_by_points} points or more.
            Together they lower the score by at most {cfg.reducer_cap} points.
          </li>
          <li>Medium is also forced by I-12 (corrected invoice) and by the incomplete checks marked below.</li>
        </ul>
      </section>

      {GROUPS.map((g) => {
        const list = cfg.criteria.filter((c) => c.id.startsWith(g.prefix));
        if (list.length === 0) return null;
        return (
          <section key={g.prefix} aria-labelledby={`g-${g.prefix}`} className="space-y-3">
            <div>
              <h2 id={`g-${g.prefix}`} className="text-lg font-semibold">
                {g.title} <span className="text-sm font-normal text-ink-3">({list.length})</span>
              </h2>
              <p className="text-sm text-ink-2">{g.blurb}</p>
            </div>
            <Card>
              <ul>
                {list.map((c) => (
                  <CriterionRow key={c.id} c={c} cfg={cfg} />
                ))}
              </ul>
            </Card>
          </section>
        );
      })}

      <section aria-labelledby="incomplete" className="space-y-3">
        <div>
          <h2 id="incomplete" className="text-lg font-semibold">When a data source is unavailable</h2>
          <p className="text-sm text-ink-2">The check does not guess. It records the gap and hands it to an investigator.</p>
        </div>
        <Card>
          <ul>
            {Object.entries(cfg.incomplete_tasks).map(([code, t]) => (
              <li key={code} className="grid gap-2 border-t border-line px-4 py-3 first:border-t-0 sm:grid-cols-[14rem_1fr]">
                <div className="flex flex-wrap items-start gap-2">
                  <span className="break-all font-mono text-xs font-semibold">{code}</span>
                  {FORCES_MEDIUM.has(code) && <Badge tone="warn">forces medium</Badge>}
                </div>
                <p className="text-sm text-ink-2" lang="de">
                  <Badge tone="info" className="mr-2">{AGENT_LABEL[t.agent]}</Badge>
                  {t.task}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      </section>

      <section aria-labelledby="main" className="space-y-3">
        <h2 id="main" className="text-lg font-semibold">After the investigators (medium only)</h2>
        <Card className="p-4">
          <p className="mb-2 text-sm text-ink-2">Main&apos;s LLM decides on the three reports, but these rules in code always win:</p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">
            <li>A missing report, a timeout or INSUFFICIENT_DATA → rejected (formal).</li>
            <li>A CRITICAL report or a DONT_PAY recommendation → rejected (risk).</li>
            <li>The wallet is blocked only when the wallet report is CRITICAL with a critical issue.</li>
          </ul>
        </Card>
      </section>

      <section aria-labelledby="params" className="space-y-3">
        <h2 id="params" className="text-lg font-semibold">Parameters</h2>
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <tbody>
              {Object.entries(p).map(([k, v]) => (
                <tr key={k} className="border-t border-line first:border-t-0">
                  <td className="px-4 py-2 font-mono text-xs text-ink-2">{k}</td>
                  <td className="px-4 py-2 font-mono text-xs">{Array.isArray(v) ? v.join(", ") : String(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <p className="text-xs text-ink-3">
          Source: <span className="font-mono">backend/config/criteria.json</span>. The running backend uses the copy in its
          image; after editing the file, run <span className="font-mono">npm run stack</span>.
        </p>
      </section>
    </div>
  );
}
