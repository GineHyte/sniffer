// Typed access to the customer gateway (docs/openapi/customer-api.yaml → lib/generated, `npm run gen:api`).
// All calls are same-origin /api/*; next.config.ts forwards them to customer/api.mjs.
import type { components } from "./generated/customer-api.d.ts";

type Schemas = components["schemas"];
export type GatewayConfig = Schemas["GatewayConfig"];
export type SubmitResult = Schemas["SubmitResult"];
export type CaseWithCheck = Schemas["CaseWithCheck"];
export type CaseView = Schemas["CaseView"];
export type CheckProjection = Schemas["CheckProjection"];
export type FiredCriterion = Schemas["FiredCriterion"];
export type InvestigatorView = Schemas["InvestigatorView"];

export const EXPLORER_TX = "https://preprod.cardanoscan.io/transaction/";

export class GatewayError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers: { accept: "application/json", ...init?.headers }, cache: "no-store" });
  } catch {
    throw new GatewayError(0, "gateway_unreachable");
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {}
  if (!response.ok) {
    const error = body as { error?: string; message?: string } | null;
    // Next answers 500 with an HTML page when the rewrite target is down.
    const code = error?.error ?? (response.status >= 500 ? "gateway_unreachable" : `http_${response.status}`);
    throw new GatewayError(response.status, code, error?.message);
  }
  return body as T;
}

export const getConfig = () => call<GatewayConfig>("/api/config");

export const submitInvoice = (xml: string) =>
  call<SubmitResult>("/api/invoices", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ xml }) });

export const getCase = (caseId: string) => call<CaseWithCheck>(`/api/cases/${encodeURIComponent(caseId)}`);
