// Browser-side checks of an uploaded file before anything is paid. The backend still does every real check;
// these only stop obvious mistakes (wrong file, too large, not UTF-8) and derive the case ID Main will use.

export const CASE_ID_RE = /^case-[0-9a-f]{32}$/;

/** Same guard as customer/api.mjs looksLikeEInvoice: first element is a CII CrossIndustryInvoice or a UBL Invoice. */
export function looksLikeEInvoice(xml: string): boolean {
  const body = xml.replace(/^﻿/, "").replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>/g, "").trimStart();
  return /^<(?:[A-Za-z_][\w.-]*:)?(?:CrossIndustryInvoice|Invoice)[\s/>]/.test(body);
}

/** Main's case ID: `case-` + first 32 hex chars of SHA-256 over the exact UTF-8 XML text (main/case-store.mjs intakeIds). */
export async function caseIdFor(xml: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(xml));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `case-${hex.slice(0, 32)}`;
}

export type FileCheck = { ok: true; xml: string } | { ok: false; error: string };

/** Decodes and checks one file's bytes. Errors are customer-facing German text. */
export function checkFile(name: string, bytes: Uint8Array, maxXmlBytes: number): FileCheck {
  if (!/\.xml$/i.test(name)) return { ok: false, error: "Nur XML-Dateien (XRechnung / ZUGFeRD-XML)." };
  if (bytes.byteLength > maxXmlBytes) return { ok: false, error: `Datei größer als ${Math.floor(maxXmlBytes / 1000)} kB.` };
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, error: "Datei ist nicht UTF-8-kodiert." };
  }
  if (!xml.trim()) return { ok: false, error: "Datei ist leer." };
  if (!looksLikeEInvoice(xml)) return { ok: false, error: "Keine E-Rechnung (CII oder UBL) erkannt." };
  return { ok: true, xml };
}

/** "2000000" lovelace → "2" / "2,5" tADA (German decimal comma, no trailing zeros). */
export function formatAda(lovelace: string | bigint): string {
  const value = BigInt(lovelace);
  const whole = value / 1_000_000n;
  const frac = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole},${frac}` : `${whole}`;
}

export const shortHash = (hash: string, keep = 8) => (hash.length > keep * 2 + 1 ? `${hash.slice(0, keep)}…${hash.slice(-keep)}` : hash);
