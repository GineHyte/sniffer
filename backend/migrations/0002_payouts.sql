CREATE TABLE payout_intents (
  payout_id      text PRIMARY KEY,                -- 'pay_' + ULID
  invoice_hash   text NOT NULL UNIQUE REFERENCES invoices(invoice_hash),
  check_id       text NOT NULL,
  wallet_hash    text NOT NULL,
  to_address     text NOT NULL,                   -- FR-32a exception (O1)
  amount_eur     numeric(14,2) NOT NULL,
  ada_per_eur    numeric(18,6) NOT NULL,
  lovelace       bigint NOT NULL CHECK (lovelace > 0),
  state          text NOT NULL CHECK (state IN ('authorized','submitting','submitted','confirmed','failed','unknown')),
  tx_hash        text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payout_intents_created_idx ON payout_intents (created_at);
CREATE INDEX payout_intents_wallet_idx ON payout_intents (wallet_hash);
CREATE INDEX payout_intents_state_idx ON payout_intents (state, updated_at);
