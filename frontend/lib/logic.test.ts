import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { caseIdFor, checkFile, formatAda, looksLikeEInvoice } from "./einvoice.ts";
import { initialQueue, nextToPay, persistable, queueReducer, restorable, type Item, type QueueState } from "./queue.ts";
import { isSettled, outcome, steps } from "./progress.ts";
import { sha256 } from "./sha256.ts";
import type { CaseView } from "./api.ts";

const XML = readFileSync(new URL("../../docs/fixtures/f1.xml", import.meta.url), "utf8");

const item = (key: string, caseId: string | null, phase: Item["phase"] = "ready"): Item => ({
  key, fileName: `${key}.xml`, sizeBytes: 1, xml: "<Invoice/>", caseId, preview: null, phase, error: null, txHash: null, existing: false, attempts: 0,
});

const view = (patch: Partial<CaseView>): CaseView => ({
  case_id: "case-" + "0".repeat(32), status: "accepted", created_at: "", updated_at: "", check_id: null,
  intake: { tx_hash: null, state: "confirmed", paid_at: null, confirmed_at: null },
  band: null, risk_score: null, investigators: null, decision: null, payout: null, inspection: null, ...patch,
});

test("caseIdFor matches Main's intakeIds (sha256 over the exact XML)", async () => {
  assert.equal(await caseIdFor(XML), `case-${createHash("sha256").update(XML, "utf8").digest("hex").slice(0, 32)}`);
});

test("JS sha256 fallback (plain-HTTP pages without crypto.subtle) matches node:crypto", () => {
  // Lengths around the 55/56/64-byte padding edges, plus the real fixture with umlauts.
  for (const text of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "a".repeat(119), XML]) {
    const bytes = new TextEncoder().encode(text);
    assert.equal(Buffer.from(sha256(bytes)).toString("hex"), createHash("sha256").update(bytes).digest("hex"), `length ${bytes.length}`);
  }
});

test("checkFile refuses wrong names, sizes, encodings and non-invoices", () => {
  const bytes = new TextEncoder().encode(XML);
  assert.equal(checkFile("f1.xml", bytes, 500_000).ok, true);
  assert.equal(checkFile("f1.pdf", bytes, 500_000).ok, false);
  assert.equal(checkFile("f1.xml", bytes, 100).ok, false);
  assert.equal(checkFile("x.xml", new Uint8Array([0xff, 0xfe]), 500_000).ok, false);
  assert.equal(checkFile("x.xml", new TextEncoder().encode("<html/>"), 500_000).ok, false);
  assert.equal(looksLikeEInvoice('<?xml version="1.0"?><ubl:Invoice xmlns:ubl="x"/>'), true);
});

test("formatAda uses a decimal point and drops trailing zeros", () => {
  assert.equal(formatAda("2000000"), "2");
  assert.equal(formatAda("2500000"), "2.5");
  assert.equal(formatAda(1n), "0.000001");
});

test("queue marks a second copy of the same XML as duplicate", () => {
  const state = queueReducer(initialQueue, { type: "add", items: [item("a", "case-1"), item("b", "case-1"), item("c", "case-2")] });
  assert.deepEqual(state.items.map((i) => i.phase), ["ready", "duplicate", "ready"]);
});

test("queue pays one item at a time and pauses all on a refused intake", () => {
  let state: QueueState = queueReducer(initialQueue, { type: "add", items: [item("a", "case-1"), item("b", "case-2")] });
  assert.equal(nextToPay(state, 0), null, "nothing before start");
  state = queueReducer(state, { type: "start" });
  assert.equal(nextToPay(state, 0)?.key, "a");
  state = queueReducer(state, { type: "payStarted", key: "a" });
  assert.equal(nextToPay(state, 0), null, "one payment at a time");
  state = queueReducer(state, { type: "refused", key: "a", retryAt: 1000 });
  assert.equal(nextToPay(state, 500), null, "paused");
  state = queueReducer(state, { type: "wake", now: 500 });
  assert.equal(state.items[0].phase, "waiting");
  state = queueReducer(state, { type: "wake", now: 1000 });
  assert.equal(nextToPay(state, 1000)?.key, "a", "the refused item goes first again");
  state = queueReducer(state, { type: "payStarted", key: "a" });
  assert.equal(state.items[0].attempts, 2);
  state = queueReducer(state, { type: "paid", key: "a", caseId: "case-1", txHash: "ab", existing: false });
  assert.equal(state.items[0].xml, null);
  assert.equal(nextToPay(state, 1000)?.key, "b");
});

test("a failed item can be retried and paying items cannot be removed", () => {
  let state = queueReducer(initialQueue, { type: "add", items: [item("a", "case-1", "queued")] });
  state = queueReducer(state, { type: "payStarted", key: "a" });
  assert.equal(queueReducer(state, { type: "remove", key: "a" }).items.length, 1);
  state = queueReducer(state, { type: "failed", key: "a", error: "x" });
  state = queueReducer(state, { type: "retry", key: "a" });
  assert.equal(state.items[0].phase, "queued");
});

test("steps and outcome follow a medium case to its confirmed payout", () => {
  const investigating = view({ status: "investigating", band: "medium", risk_score: 42 });
  assert.deepEqual(steps(investigating).map((s) => s.state), ["done", "done", "done", "active", "pending", "pending"]);
  assert.equal(isSettled(investigating), false);
  const decision = { decision: "PAY" as const, final_decision: "approved" as const, reason_type: null, block_wallet: false, decline_reasons: [], decided_by: "agents" as const };
  const submitted = view({ status: "completed", band: "medium", decision, payout: { phase: "submitted", state: "submitted", payout_id: "p", tx_hash: "t", code: null } });
  assert.equal(isSettled(submitted), false, "keep polling until the payout confirms");
  assert.equal(steps(submitted)[5].state, "active");
  const done = { ...submitted, payout: { ...submitted.payout!, phase: "done" as const, state: "confirmed" as const } };
  assert.equal(isSettled(done), true);
  assert.deepEqual(outcome(done), { tone: "approved", label: "Approved · paid out" });
});

test("a high-band rejection skips review and payout; an inspection stop marks the stuck step", () => {
  const decision = { decision: "DONT_PAY" as const, final_decision: "rejected" as const, reason_type: "formal" as const, block_wallet: false, decline_reasons: [], decided_by: "initial_check" as const };
  const high = view({ status: "completed", band: "high", risk_score: 100, decision });
  assert.deepEqual(steps(high).map((s) => s.state), ["done", "done", "done", "skipped", "done", "skipped"]);
  assert.equal(outcome(high).tone, "rejected");
  const stuck = view({ status: "needs_inspection", intake: { tx_hash: null, state: "submitted", paid_at: null, confirmed_at: null }, inspection: { code: "intake_unconfirmed" } });
  assert.equal(steps(stuck)[1].state, "failed");
  assert.equal(isSettled(stuck), true);
});

test("only submitted items are persisted, without XML, and restore skips known cases", () => {
  let state = queueReducer(initialQueue, { type: "add", items: [item("a", "case-1", "queued"), item("b", "case-2")] });
  state = queueReducer(state, { type: "paid", key: "a", caseId: "case-1", txHash: null, existing: false });
  const saved = JSON.stringify(persistable(state));
  assert.deepEqual(restorable(saved).map((i) => [i.caseId, i.xml]), [["case-1", null]]);
  assert.deepEqual(restorable("{broken"), []);
  const restored = queueReducer(state, { type: "restore", items: restorable(saved) });
  assert.equal(restored.items.length, 2, "case-1 is already in the list");
});
