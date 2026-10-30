CREATE TABLE subjects (
  hash          text PRIMARY KEY,
  type          text NOT NULL CHECK (type IN ('wallet', 'supplier', 'pair')),
  approved      integer NOT NULL DEFAULT 0 CHECK (approved >= 0),
  rejected_risk integer NOT NULL DEFAULT 0 CHECK (rejected_risk >= 0),
  trust         numeric(4,3) NOT NULL DEFAULT 0 CHECK (trust BETWEEN -1 AND 1),
  status        text NOT NULL DEFAULT 'normal' CHECK (status IN ('normal', 'blocked')),
  block_source  text CHECK (block_source IN ('OFAC', 'internal')),
  block_reason  text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invoices (
  invoice_hash          text PRIMARY KEY,
  check_id              text NOT NULL UNIQUE,
  supplier_hash         text NOT NULL,
  wallet_hash           text NOT NULL,
  pair_hash             text NOT NULL,
  name_hash             text NOT NULL,
  email_domain_hash     text,
  phone_hash            text,
  postal_hash           text,
  amount                numeric(14,2) NOT NULL,
  currency              char(3) NOT NULL,
  issue_date            date NOT NULL,
  type_code             text NOT NULL,
  initial_band          text NOT NULL CHECK (initial_band IN ('low', 'medium', 'high')),
  initial_score         integer NOT NULL,
  final_decision        text CHECK (final_decision IN ('approved', 'rejected')),
  final_reason_type     text CHECK (final_reason_type IN ('risk', 'formal')),
  final_block_wallet    boolean,
  final_decline_reasons jsonb,
  decided_by            text CHECK (decided_by IN ('initial_check', 'agents', 'seed')),
  decided_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoices_supplier_idx ON invoices (supplier_hash, final_decision, issue_date DESC, created_at DESC);
CREATE INDEX invoices_wallet_idx ON invoices (wallet_hash);
CREATE INDEX invoices_created_idx ON invoices (created_at);

CREATE TABLE checks (
  check_id   text PRIMARY KEY,
  band       text NOT NULL CHECK (band IN ('low', 'medium', 'high')),
  result     jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX checks_created_idx ON checks (created_at);

CREATE TABLE sanction_names (
  name_normalized text NOT NULL,
  source          text NOT NULL,
  sdn_uid         text NOT NULL,
  PRIMARY KEY (name_normalized, source, sdn_uid)
);

CREATE TABLE list_updates (
  source            text PRIMARY KEY,
  last_success_at   timestamptz NOT NULL,
  entries           integer NOT NULL,
  cardano_addresses integer NOT NULL
);
