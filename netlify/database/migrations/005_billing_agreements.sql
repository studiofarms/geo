-- All money is integer minor units; never sum different currencies together.
CREATE TABLE gocoach.invoice_counters (
  workspace_id uuid NOT NULL REFERENCES gocoach.workspaces(id),
  year integer NOT NULL CHECK (year BETWEEN 2000 AND 9999),
  next_number bigint NOT NULL DEFAULT 1 CHECK (next_number > 0),
  PRIMARY KEY (workspace_id, year)
);
CREATE TABLE gocoach.invoices (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  cohort_id uuid NOT NULL,
  buyer_id uuid NOT NULL,
  number text NOT NULL,
  title text NOT NULL,
  currency char(3) NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor BETWEEN 0 AND 9007199254740991),
  tax_minor bigint NOT NULL DEFAULT 0 CHECK (tax_minor BETWEEN 0 AND 9007199254740991),
  discount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_minor BETWEEN 0 AND subtotal_minor),
  total_minor bigint NOT NULL CHECK (total_minor BETWEEN 1 AND 9007199254740991),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'void')),
  due_on date NOT NULL,
  issued_at timestamptz,
  billing_snapshot jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(billing_snapshot) = 'object'),
  payment_revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, number),
  UNIQUE (workspace_id, id, currency),
  FOREIGN KEY (workspace_id, cohort_id, buyer_id) REFERENCES gocoach.cohorts(workspace_id, id, buyer_id),
  CHECK (total_minor = subtotal_minor + tax_minor - discount_minor),
  CHECK (status <> 'issued' OR issued_at IS NOT NULL)
);
CREATE INDEX invoices_buyer_idx ON gocoach.invoices(workspace_id, buyer_id, status, due_on);
CREATE TABLE gocoach.invoice_lines (
  workspace_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  position integer NOT NULL CHECK (position > 0),
  description text NOT NULL,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor BETWEEN 0 AND 9007199254740991),
  amount_minor bigint GENERATED ALWAYS AS (quantity::bigint * unit_price_minor) STORED,
  PRIMARY KEY (workspace_id, invoice_id, position),
  FOREIGN KEY (workspace_id, invoice_id) REFERENCES gocoach.invoices(workspace_id, id),
  CHECK (quantity::numeric * unit_price_minor <= 9007199254740991)
);
CREATE TABLE gocoach.payments (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'payment' CHECK (kind IN ('payment', 'refund')),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 9007199254740991),
  status text NOT NULL DEFAULT 'settled' CHECK (status IN ('pending', 'settled', 'failed')),
  method text NOT NULL,
  reference text NOT NULL,
  provider text,
  provider_payment_id text,
  received_at timestamptz NOT NULL,
  recorded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, invoice_id, reference),
  UNIQUE (workspace_id, provider, provider_payment_id),
  FOREIGN KEY (workspace_id, invoice_id, currency) REFERENCES gocoach.invoices(workspace_id, id, currency),
  FOREIGN KEY (workspace_id, recorded_by) REFERENCES gocoach.users(workspace_id, id)
);
CREATE INDEX payments_invoice_idx ON gocoach.payments(workspace_id, invoice_id, status);
CREATE INDEX payments_revenue_idx ON gocoach.payments(workspace_id, received_at) WHERE status = 'settled';

CREATE TABLE gocoach.contracts (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  cohort_id uuid NOT NULL,
  buyer_id uuid NOT NULL,
  title text NOT NULL,
  terms text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 0 AND 9007199254740991),
  currency char(3) NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  program_name text NOT NULL,
  company_name text NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in-review', 'acknowledged', 'signed', 'declined', 'void')),
  content_hash text CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  requested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, id, content_hash),
  FOREIGN KEY (workspace_id, cohort_id, buyer_id) REFERENCES gocoach.cohorts(workspace_id, id, buyer_id),
  CHECK (ends_on > starts_on),
  CHECK (status = 'draft' OR (content_hash IS NOT NULL AND requested_at IS NOT NULL))
);
CREATE INDEX contracts_buyer_idx ON gocoach.contracts(workspace_id, buyer_id, status);
CREATE TABLE gocoach.contract_envelopes (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL,
  provider text NOT NULL,
  provider_envelope_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('created', 'sent', 'delivered', 'completed', 'declined', 'voided', 'failed')),
  signed_file_id uuid,
  certificate_file_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, provider, provider_envelope_id),
  FOREIGN KEY (workspace_id, contract_id) REFERENCES gocoach.contracts(workspace_id, id),
  FOREIGN KEY (workspace_id, signed_file_id) REFERENCES gocoach.file_objects(workspace_id, id),
  FOREIGN KEY (workspace_id, certificate_file_id) REFERENCES gocoach.file_objects(workspace_id, id)
);
CREATE TABLE gocoach.contract_acknowledgements (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL,
  user_id uuid NOT NULL,
  name text NOT NULL,
  content_hash text NOT NULL,
  method text NOT NULL CHECK (method IN ('local-prototype', 'provider-signature')),
  consent_text text NOT NULL,
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, contract_id, user_id, content_hash),
  FOREIGN KEY (workspace_id, contract_id, content_hash) REFERENCES gocoach.contracts(workspace_id, id, content_hash),
  FOREIGN KEY (workspace_id, user_id) REFERENCES gocoach.users(workspace_id, id)
);
