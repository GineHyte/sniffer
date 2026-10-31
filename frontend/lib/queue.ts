// Multi-upload queue without a broker: the browser pays one invoice at a time through the gateway (one XML = one payment
// = one case). A 503 too_many_unconfirmed_intakes pauses the whole queue (Main refuses every new intake until earlier
// payments confirm) and the same item is retried after the pause. Cases are polled in parallel once submitted.

export type Preview = {
  invoiceNumber: string | null;
  seller: string | null;
  sellerVat: string | null;
  amount: string | null;
  currency: string | null;
  wallet: string | null;
};

export type Phase =
  | "invalid" // failed the browser checks, never sent
  | "duplicate" // same XML (same case ID) as an earlier item
  | "ready" // waiting for the user's "pay and check" click
  | "queued" // will be paid when it is first in line
  | "paying" // POST /api/invoices running
  | "waiting" // Main refused new intakes; retried after pausedUntil
  | "submitted" // paid (or already existing case); the case is polled
  | "failed"; // payment step failed; can be retried by hand

export type Item = {
  key: string;
  fileName: string;
  sizeBytes: number;
  xml: string | null;
  caseId: string | null;
  preview: Preview | null;
  phase: Phase;
  error: string | null;
  txHash: string | null;
  existing: boolean;
  attempts: number;
};

export type QueueState = { items: Item[]; pausedUntil: number };

export type Action =
  | { type: "restore"; items: Item[] }
  | { type: "add"; items: Item[] }
  | { type: "remove"; key: string }
  | { type: "start" }
  | { type: "payStarted"; key: string }
  | { type: "paid"; key: string; caseId: string; txHash: string | null; existing: boolean }
  | { type: "refused"; key: string; retryAt: number }
  | { type: "failed"; key: string; error: string }
  | { type: "retry"; key: string }
  | { type: "wake"; now: number }
  | { type: "clearDone" };

export const initialQueue: QueueState = { items: [], pausedUntil: 0 };

const patch = (state: QueueState, key: string, change: Partial<Item>): QueueState => ({
  ...state,
  items: state.items.map((item) => (item.key === key ? { ...item, ...change } : item)),
});

const REMOVABLE: Phase[] = ["invalid", "duplicate", "ready", "queued", "failed"];

export function queueReducer(state: QueueState, action: Action): QueueState {
  switch (action.type) {
    case "restore": {
      const known = new Set(state.items.map((item) => item.caseId));
      return { ...state, items: [...action.items.filter((item) => !known.has(item.caseId)), ...state.items] };
    }
    case "add": {
      const seen = new Set(state.items.filter((item) => item.phase !== "invalid").map((item) => item.caseId));
      const added = action.items.map((item) => {
        if (item.phase === "invalid" || !item.caseId) return item;
        if (seen.has(item.caseId)) return { ...item, phase: "duplicate" as const, xml: null, error: "Gleiche Rechnung ist schon in der Liste." };
        seen.add(item.caseId);
        return item;
      });
      return { ...state, items: [...state.items, ...added] };
    }
    case "remove": {
      const item = state.items.find((entry) => entry.key === action.key);
      if (!item || !REMOVABLE.includes(item.phase)) return state;
      return { ...state, items: state.items.filter((entry) => entry.key !== action.key) };
    }
    case "start":
      return { ...state, items: state.items.map((item) => (item.phase === "ready" ? { ...item, phase: "queued" } : item)) };
    case "payStarted":
      return patch(state, action.key, { phase: "paying", error: null, attempts: (state.items.find((i) => i.key === action.key)?.attempts ?? 0) + 1 });
    case "paid":
      // The XML is no longer needed in memory once Main holds the case.
      return patch(state, action.key, { phase: "submitted", caseId: action.caseId, txHash: action.txHash, existing: action.existing, xml: null, error: null });
    case "refused":
      return { ...patch(state, action.key, { phase: "waiting" }), pausedUntil: action.retryAt };
    case "failed":
      return patch(state, action.key, { phase: "failed", error: action.error });
    case "retry": {
      const item = state.items.find((entry) => entry.key === action.key);
      return item?.phase === "failed" ? patch(state, action.key, { phase: "queued", error: null }) : state;
    }
    case "wake":
      if (action.now < state.pausedUntil) return state;
      return { ...state, items: state.items.map((item) => (item.phase === "waiting" ? { ...item, phase: "queued" } : item)) };
    case "clearDone":
      return { ...state, items: state.items.filter((item) => item.phase !== "invalid" && item.phase !== "duplicate") };
  }
}

/** The item to pay now, or null (one payment at a time; nothing while paused or while a payment runs). */
export function nextToPay(state: QueueState, now: number): Item | null {
  if (now < state.pausedUntil) return null;
  if (state.items.some((item) => item.phase === "paying" || item.phase === "waiting")) return null;
  return state.items.find((item) => item.phase === "queued") ?? null;
}

/** Submitted items survive a reload (sessionStorage); they hold no XML, only what the list shows and the case ID. */
export const persistable = (state: QueueState): Item[] => state.items.filter((item) => item.phase === "submitted").map((item) => ({ ...item, xml: null }));

export function restorable(raw: string | null): Item[] {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(value)
      ? value.filter((item): item is Item => typeof item?.key === "string" && typeof item?.caseId === "string" && item.phase === "submitted")
      : [];
  } catch {
    return [];
  }
}

export const countBy =(state: QueueState, ...phases: Phase[]) => state.items.filter((item) => phases.includes(item.phase)).length;
