// Display-only preview of an e-invoice (CII or UBL) via the browser's DOMParser. Never used for any decision.
import type { Preview } from "./queue.ts";

const text = (node: Element | null | undefined) => node?.textContent?.trim() || null;
const all = (root: Element | Document, local: string) => Array.from(root.getElementsByTagNameNS("*", local));
const first = (root: Element | Document | null | undefined, ...path: string[]): Element | null => {
  let current: Element | Document | null | undefined = root;
  for (const local of path) {
    if (!current) return null;
    current = all(current, local)[0] ?? null;
  }
  return (current as Element | null) ?? null;
};
const childText = (parent: Element | null, local: string) =>
  text(parent ? Array.from(parent.children).find((child) => child.localName === local) : null);

export function previewOf(xml: string): Preview | null {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) return null;
  const root = doc.documentElement;
  if (root.localName === "CrossIndustryInvoice") {
    const seller = first(doc, "SellerTradeParty");
    const vat = seller ? all(seller, "ID").find((id) => id.getAttribute("schemeID") === "VA") : null;
    const due = first(doc, "DuePayableAmount");
    return {
      invoiceNumber: childText(first(doc, "ExchangedDocument"), "ID"),
      seller: childText(seller, "Name"),
      sellerVat: text(vat),
      amount: text(due),
      currency: due?.getAttribute("currencyID") || text(first(doc, "InvoiceCurrencyCode")),
      wallet: text(first(doc, "PayeePartyCreditorFinancialAccount", "ProprietaryID")) ?? text(first(doc, "PayeePartyCreditorFinancialAccount", "IBANID")),
    };
  }
  if (root.localName === "Invoice") {
    const supplier = first(doc, "AccountingSupplierParty");
    const payable = first(doc, "LegalMonetaryTotal", "PayableAmount");
    return {
      invoiceNumber: childText(root, "ID"),
      seller: text(first(supplier, "RegistrationName")) ?? text(first(supplier, "PartyName", "Name")),
      sellerVat: text(first(supplier, "PartyTaxScheme", "CompanyID")),
      amount: text(payable),
      currency: payable?.getAttribute("currencyID") || childText(root, "DocumentCurrencyCode"),
      wallet: text(first(doc, "PayeeFinancialAccount", "ID")),
    };
  }
  return null;
}
